"""Joint ownership tests without loading model weights or external assets."""
from types import SimpleNamespace
import ast
from pathlib import Path
import threading
import unittest

import torch

from motion_scope import GROUP_JOINTS, scope_reference, scope_conditions, project_scope, blend_action_start
from retarget import CORE_JOINTS
from rolling_sessions import RollingSessions, SessionError, segment_frame_counts


class GeometryRep:
    """Small kinematic feature codec with the native rotation/root layout."""
    def __init__(self):
        names = list(CORE_JOINTS)
        parents = [-1, 0, 1, 2, 3, 4, 5, 4, 7, 8, 9, 10, 10, 4, 13, 14, 15, 16, 16, 0, 19, 20, 21, 0, 23, 24, 25]
        joints = torch.zeros(27, 3)
        joints[0, 1] = .9
        for index in range(1, 27):
            joints[index] = joints[parents[index]]
            if index < 7:
                joints[index, 1] += .1
            elif index < 19:
                joints[index, 0] += -.15 if index < 13 else .15
            else:
                joints[index, 1] -= .3
        self.skeleton = SimpleNamespace(bone_order_names=names, joint_parents=torch.tensor(parents),
                                        neutral_joints=joints, root_idx=0)
        self.slice_dict = {"root_pos": slice(0, 3), "global_root_heading": slice(3, 5), "global_rot_data": slice(5, 167)}
        self.nfeats_dict = {"root_pos": 3}

    def __call__(self, local, root, to_normalize=True):
        glob = local.clone()
        for index, parent in enumerate(self.skeleton.joint_parents.tolist()):
            if parent >= 0:
                glob[..., index, :, :] = glob[..., parent, :, :] @ local[..., index, :, :]
        rotations = glob[..., :2].transpose(-1, -2).flatten(-2).flatten(-2)
        return torch.cat([root, torch.zeros(*root.shape[:2], 2), rotations], dim=-1)

    def inverse(self, features, is_normalized=True):
        values = features[..., 5:].reshape(*features.shape[:2], 27, 2, 3)
        x = torch.nn.functional.normalize(values[..., 0, :], dim=-1)
        raw_y = values[..., 1, :] - (values[..., 1, :] * x).sum(-1, keepdim=True) * x
        y = torch.nn.functional.normalize(raw_y, dim=-1)
        glob = torch.stack([x, y, torch.linalg.cross(x, y)], dim=-1)
        local = glob.clone()
        for index, parent in enumerate(self.skeleton.joint_parents.tolist()):
            if parent >= 0:
                local[..., index, :, :] = glob[..., parent, :, :].transpose(-1, -2) @ glob[..., index, :, :]
        return {"local_rot_mats": local, "global_rot_mats": glob, "root_positions": features[..., :3]}

    def unnormalize(self, features):
        return features

    def get_root_heading_angle(self, features):
        return torch.zeros(*features.shape[:2])


def rotation(angle):
    a = torch.tensor(angle)
    c, s = torch.cos(a), torch.sin(a)
    return torch.tensor([[c, -s, 0], [s, c, 0], [0, 0, 1]])


class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.rep = GeometryRep()
        self.initial = scope_reference(self.rep, [], None)

    def native(self, local, root):
        return self.rep(local, root, to_normalize=True)

    def test_fresh_reference_uses_anatomical_arms_down_and_grounded_skeleton(self):
        pose = self.rep.inverse(self.native(self.initial["local"], self.initial["root"]))
        for side in ["Left", "Right"]:
            upper = CORE_JOINTS.index(side + "Arm")
            lower = CORE_JOINTS.index(side + "ForeArm")
            direction = self.rep.skeleton.neutral_joints[lower] - self.rep.skeleton.neutral_joints[upper]
            world = pose["global_rot_mats"][0, 0, upper] @ direction
            self.assertAlmostEqual(world[0].item(), 0, places=6)
            self.assertLess(world[1].item(), 0)
        self.assertGreater(self.initial["root"][0, 0, 1].item(), 0)

    def test_head_only_keeps_generated_head_but_blocks_invented_arms_and_root(self):
        reference = scope_reference(self.rep, ["head"], None)
        local = rotation(.7).repeat(1, 8, 27, 1, 1)
        root = torch.tensor([3., 4., 5.]).repeat(1, 8, 1)
        corrected, decoded = project_scope(self.rep, reference, self.native(local, root), 0, 8)
        held = ~reference["owned"]
        torch.testing.assert_close(decoded["local_rot_mats"][:, :, held], reference["local"][:, :, held].expand(-1, 8, -1, -1, -1))
        torch.testing.assert_close(decoded["root_positions"], reference["root"].expand(-1, 8, -1))
        torch.testing.assert_close(decoded["local_rot_mats"][:, :, ~held], local[:, :, ~held])
        # The native state retained for the next inference is the corrected pose.
        next_reference = scope_reference(self.rep, [], corrected)
        torch.testing.assert_close(next_reference["local"], decoded["local_rot_mats"][:, -1:])
        torch.testing.assert_close(next_reference["root"], decoded["root_positions"][:, -1:])

    def test_held_limb_follows_moving_torso_in_local_space_without_freezing_the_world(self):
        # A raised (horizontal) arm is a deliberate pose and stays local to the torso.
        raised = torch.eye(3).repeat(1, 1, 27, 1, 1)
        reference = scope_reference(self.rep, ["torso", "root"], self.native(raised, torch.tensor([[[0., .9, 0.]]])))
        self.assertEqual(reference["hanging"], {})
        local = reference["local"].expand(-1, 8, -1, -1, -1).clone()
        local[..., 2, :, :] = rotation(.3)
        local[..., 0, :, :] = rotation(.6)
        root = torch.tensor([2., .9, 1.]).repeat(1, 8, 1)
        _, decoded = project_scope(self.rep, reference, self.native(local, root), 0, 8)
        torch.testing.assert_close(decoded["root_positions"], root)
        torch.testing.assert_close(decoded["local_rot_mats"][..., 0, :, :], local[..., 0, :, :])
        arm = CORE_JOINTS.index("LeftArm")
        torch.testing.assert_close(decoded["local_rot_mats"][:, :, arm], reference["local"][:, :, arm].expand(-1, 8, -1, -1))
        rest = self.rep.inverse(self.native(reference["local"], reference["root"]))
        self.assertFalse(torch.allclose(decoded["global_rot_mats"][:, :1, arm], rest["global_rot_mats"][:, :, arm]))

    def arm_direction(self, decoded, side="Left"):
        names = self.rep.skeleton.bone_order_names
        upper, lower = names.index(side + "Arm"), names.index(side + "ForeArm")
        bone = self.rep.skeleton.neutral_joints[lower] - self.rep.skeleton.neutral_joints[upper]
        return decoded["global_rot_mats"][..., upper, :, :] @ (bone / bone.norm())

    def test_lowered_unowned_arms_keep_hanging_when_the_torso_leans(self):
        reference = scope_reference(self.rep, ["torso", "root", "leftLeg", "rightLeg"], None)
        self.assertEqual(set(reference["hanging"]), {"Left", "Right"})
        local = reference["local"].expand(-1, 8, -1, -1, -1).clone()
        lean = torch.tensor([[1., 0, 0], [0, .8, -.6], [0, .6, .8]])  # forward pitch about x
        local[..., 1, :, :] = lean
        root = torch.tensor([0., .9, 0.]).repeat(1, 8, 1)
        _, decoded = project_scope(self.rep, reference, self.native(local, root), 0, 8)
        for side in ["Left", "Right"]:
            direction = self.arm_direction(decoded, side)
            torch.testing.assert_close(direction, torch.tensor([0., -1., 0.]).expand_as(direction), atol=1e-5, rtol=0)
        # Without the correction the lean would have swung the arms forward.
        names = self.rep.skeleton.bone_order_names
        forearm = names.index("LeftForeArm")
        torch.testing.assert_close(decoded["local_rot_mats"][..., forearm, :, :],
                                   reference["local"][..., forearm, :, :].expand(-1, 8, -1, -1))

    def test_hanging_arms_turn_with_the_chest_instead_of_staying_in_world_space(self):
        reference = scope_reference(self.rep, ["root"], None)
        local = reference["local"].expand(-1, 8, -1, -1, -1).clone()
        c, s = torch.cos(torch.tensor(.8)), torch.sin(torch.tensor(.8))
        yaw = torch.tensor([[c, 0, s], [0, 1, 0], [-s, 0, c]])
        local[..., 0, :, :] = yaw
        root = torch.tensor([0., .9, 0.]).repeat(1, 8, 1)
        _, decoded = project_scope(self.rep, reference, self.native(local, root), 0, 8)
        arm = self.rep.skeleton.bone_order_names.index("LeftArm")
        rest = self.rep.inverse(self.native(reference["local"], reference["root"]))["global_rot_mats"][0, 0, arm]
        torch.testing.assert_close(decoded["global_rot_mats"][0, :, arm], (yaw @ rest).expand(8, -1, -1), atol=1e-5, rtol=0)

    def test_hanging_arm_never_pushes_the_hand_below_the_ankles(self):
        from motion_scope import _joint_positions
        names = self.rep.skeleton.bone_order_names
        reference = scope_reference(self.rep, ["torso", "root", "leftLeg", "rightLeg"], None)
        local = reference["local"].expand(-1, 4, -1, -1, -1).clone()
        # Raise the feet above the pelvis and lean the torso forward so that a
        # gravity-aligned hand would end up below the ankles while the held
        # (torso-local) arm points forward above them.
        root = torch.tensor([0., .9, 0.]).repeat(1, 4, 1)
        for leg in ["LeftUpLeg", "RightUpLeg"]:
            local[..., names.index(leg), :, :] = torch.tensor([[1., 0, 0], [0, -1, 0], [0, 0, -1]])
        local[..., names.index("Spine3"), :, :] = torch.tensor([[1., 0, 0], [0, 0, -1], [0, 1, 0]])
        samples = self.native(local, root)

        def heights(ref):
            _, decoded = project_scope(self.rep, ref, samples, 0, 4)
            positions = _joint_positions(self.rep.skeleton, decoded["global_rot_mats"], decoded["root_positions"])
            floor = positions[..., [names.index("LeftFoot"), names.index("RightFoot")], 1].min(-1).values
            return positions, floor

        held, _ = heights({**reference, "hanging": {}})
        positions, floor = heights(reference)
        for side in ["Left", "Right"]:
            hand = names.index(side + "Hand")
            self.assertTrue(torch.all(held[..., hand, 1] >= floor))
            # Only as low as the ankles, never lower than both the ankles and the held pose.
            self.assertTrue(torch.all(positions[..., hand, 1] >= floor - 1e-5))
            self.assertTrue(torch.all(positions[..., hand, 1] < held[..., hand, 1] + 1e-5))

    def test_floor_guard_eases_in_instead_of_popping_the_arm_in_one_frame(self):
        from motion_scope import GUARD_RATE
        names = self.rep.skeleton.bone_order_names
        reference = scope_reference(self.rep, ["torso", "root", "leftLeg", "rightLeg"], None)
        local = reference["local"].expand(-1, 16, -1, -1, -1).clone()
        local[..., names.index("Spine3"), :, :] = torch.tensor([[1., 0, 0], [0, 0, -1], [0, 1, 0]])
        # The feet rise above the hanging hands only in the last frames.
        for leg in ["LeftUpLeg", "RightUpLeg"]:
            local[:, 12:, names.index(leg)] = torch.tensor([[1., 0, 0], [0, -1, 0], [0, 0, -1]])
        _, decoded = project_scope(self.rep, reference, self.native(local, torch.tensor([0., .9, 0.]).repeat(1, 16, 1)), 0, 16)
        direction = self.arm_direction(decoded)[0]
        steps = torch.rad2deg(torch.acos((direction[1:] * direction[:-1]).sum(-1).clamp(-1, 1)))
        total = torch.rad2deg(torch.acos((direction[0] * direction[-1]).sum().clamp(-1, 1)))
        self.assertGreater(total.item(), 30)  # the guard did move the arm
        self.assertLess(steps.max().item(), total.item() * GUARD_RATE * 1.5)
        self.assertGreater((steps > 1e-3).sum().item(), 4)  # spread over several frames

    def test_lowered_arm_targets_generate_only_arms_that_are_still_raised(self):
        from motion_scope import arms_not_lowered
        self.assertEqual(arms_not_lowered(self.rep, None, ["leftArm", "rightArm"]), [])
        local = self.initial["local"].clone()
        local[..., CORE_JOINTS.index("RightArm"), :, :] = torch.eye(3)  # horizontal T-pose arm
        history = self.native(local, self.initial["root"])
        self.assertEqual(arms_not_lowered(self.rep, history, ["leftArm", "rightArm"]), ["rightArm"])

    def test_session_segments_validate_lowered_arm_targets(self):
        from rolling_sessions import _instruction
        base = {"text": "A person stands.", "duration": 2, "body": ["root"]}
        self.assertEqual(_instruction({"segments": [{**base, "lowerArms": ["leftArm"]}], "duration": 2})["segments"][0]["lowerArms"], ["leftArm"])
        for value in [["torso"], ["leftArm", "leftArm"], "leftArm"]:
            with self.assertRaises(SessionError):
                _instruction({"segments": [{**base, "lowerArms": value}], "duration": 2})

    def test_segment_starting_mid_air_lands_with_legs_instead_of_floating(self):
        from motion_scope import is_airborne, airborne_scope
        local = self.initial["local"].expand(-1, 2, -1, -1, -1).clone()
        jump = self.native(local, torch.tensor([[[0., .9, 0.], [0., 1.2, 0.]]]))
        standing = self.native(local, torch.tensor([[[0., .9, 0.], [0., .9, 0.]]]))
        self.assertTrue(is_airborne(self.rep, jump))
        self.assertFalse(is_airborne(self.rep, standing))
        self.assertFalse(is_airborne(self.rep, None))
        # Arms-only segment: legs and vertical pelvis are enabled, travel stays locked.
        self.assertEqual(airborne_scope(["leftArm", "rightArm"], None),
                         (["leftArm", "rightArm", "root", "leftLeg", "rightLeg"], [False, True, False]))
        # A root that forbade vertical motion keeps its horizontal limits.
        self.assertEqual(airborne_scope(["root", "torso"], [True, False, False]),
                         (["root", "torso", "leftLeg", "rightLeg"], [True, True, False]))

    def test_segment_boundary_retains_actual_previous_pose_and_prefix(self):
        previous_local = self.initial["local"].expand(-1, 4, -1, -1, -1).clone()
        arm = CORE_JOINTS.index("RightForeArm")
        previous_local[:, :, arm] = rotation(.9)
        previous_root = torch.tensor([2., .9, -1.]).repeat(1, 4, 1)
        history = self.native(previous_local, previous_root)
        reference = scope_reference(self.rep, ["head"], history)
        new_local = rotation(-.7).repeat(1, 4, 27, 1, 1)
        samples = torch.cat([history, self.native(new_local, torch.zeros(1, 4, 3))], dim=1)
        corrected, decoded = project_scope(self.rep, reference, samples, 4, 4)
        torch.testing.assert_close(decoded["local_rot_mats"][:, :4], previous_local)
        torch.testing.assert_close(decoded["local_rot_mats"][:, 4:, arm], previous_local[:, :, arm])
        torch.testing.assert_close(self.rep.inverse(corrected)["root_positions"], previous_root)

    def test_native_constraints_hold_root_without_suppressing_generated_limbs(self):
        reference = scope_reference(self.rep, ["torso", "head", "leftArm"], None)
        observed, mask = scope_conditions(self.rep, reference, 12)
        self.assertEqual(observed.shape, mask.shape)
        self.assertTrue(torch.all(mask[..., :5] == 1))
        rotations = mask[..., 5:].reshape(1, 12, 27, 6)
        # Local joint ownership is applied to decoded/native history. Dense
        # world-space rotation hints must not lock the model into a whole pose.
        self.assertTrue(torch.all(rotations == 0))
        traveling = scope_reference(self.rep, ["root", "leftLeg", "rightLeg"], None)
        self.assertEqual(scope_conditions(self.rep, traveling, 12), (None, None))

    def test_empty_scope_skips_text_and_inference_and_carries_actual_pose_into_next_body(self):
        calls, encodes, translations = [], [], []

        def encode(text):
            encodes.extend(text)
            return text[0], None

        def translate(text):
            translations.append(text)
            return text, None

        def step(**kwargs):
            calls.append(kwargs)
            history = kwargs["init_history_sequence"]
            local = rotation(.6).repeat(1, 8, 27, 1, 1)
            next_motion = self.native(local, torch.ones(1, 8, 3) * 4)
            return next_motion if history is None else torch.cat([history, next_motion], dim=1)

        def fragment(glob, root, fps, text, t_offset, **kwargs):
            return {"tracks": {}, "hips": [{"t": t_offset + i / fps, "p": value.tolist()} for i, value in enumerate(root)]}

        source = ast.parse(Path(__file__).with_name("server.py").read_text(encoding="utf-8"))
        functions = [node for node in source.body if isinstance(node, ast.FunctionDef)
                     and node.name in {"_session_plan", "_generate_session_chunk"}]
        namespace = {"torch": torch, "FPS": 20, "PATCH": 4, "GEN_LOCK": threading.Lock(),
                     "model": SimpleNamespace(gen_horizon_len=8, _encode_text=encode, autoregressive_step=step, motion_rep=self.rep,
                         _encode_init_history=lambda history, batch: (None, history[:, -1, :3], torch.zeros(batch))),
                     "DEVICE": "cpu", "NUM_BASE_STEPS": 8, "SessionError": SessionError,
                     "maybe_translate": translate, "segment_frame_counts": segment_frame_counts,
                     "to_numpy": lambda result: {key: value.numpy() for key, value in result.items()},
                     "spec_from_arrays": fragment,
                     "_apply_motion_context": lambda segments, _: (segments, {"bodyApplied": False, "fields": [], "segmentsApplied": 0})}
        exec(compile(ast.Module(body=functions, type_ignores=[]), "server.py", "exec"), namespace)
        registry = RollingSessions(20, 8, 4, namespace["_generate_session_chunk"], lambda motion, start, end: motion[:, start:end].clone())
        first_segment = {"text": "only authored facial motion", "duration": .4, "body": []}
        metadata = registry.create({"segments": [first_segment], "duration": 2, "planComplete": False, "plannerOwned": True})
        sid = metadata["sessionId"]
        first = registry.next(sid)
        self.assertEqual((calls, encodes, translations), ([], [], []))
        self.assertTrue(first["bodyInferenceSkipped"])
        self.assertEqual(first["bodyScope"], [])
        self.assertEqual(first["endTime"], .35)
        native_prefix = registry.sessions[sid].motion.clone()
        expected = scope_reference(self.rep, [], None)
        decoded = self.rep.inverse(native_prefix)
        torch.testing.assert_close(decoded["local_rot_mats"], expected["local"].expand(-1, 8, -1, -1, -1))
        self.assertEqual(registry.next(sid)["type"], "waiting")
        registry.append(sid, {"segments": [first_segment, {"text": "a new free arm motion", "duration": 1.6, "body": ["rightArm"]}],
                              "planComplete": True, "revision": 0})
        second = registry.next(sid)
        self.assertEqual(second["startTime"], .4)
        self.assertFalse(second["bodyInferenceSkipped"])
        self.assertEqual(len(calls), 1)
        self.assertIsNone(calls[0]["init_history_sequence"])
        self.assertTrue(second["actionRestarted"])
        torch.testing.assert_close(registry.sessions[sid].motion[:, :8], native_prefix)
        current = self.rep.inverse(registry.sessions[sid].motion[:, 8:])
        torch.testing.assert_close(current["root_positions"], expected["root"].expand(-1, 8, -1))
        torch.testing.assert_close(current["local_rot_mats"][:, :1], decoded["local_rot_mats"][:, -1:])

    def test_fresh_action_blend_keeps_last_pose_and_future_motion_without_mutating_prefix(self):
        history = self.native(rotation(.2).repeat(1, 4, 27, 1, 1), torch.tensor([2., 1., 3.]).repeat(1, 4, 1))
        samples = self.native(rotation(1.).repeat(1, 12, 27, 1, 1), torch.tensor([3., 2., 4.]).repeat(1, 12, 1))
        original = history.clone()
        result = blend_action_start(self.rep, history, samples, 8)
        decoded = self.rep.inverse(result)
        torch.testing.assert_close(history, original)
        torch.testing.assert_close(decoded['local_rot_mats'][:, :1], self.rep.inverse(history)['local_rot_mats'][:, -1:])
        torch.testing.assert_close(decoded['root_positions'][:, :1], history[:, -1:, :3])
        torch.testing.assert_close(result[:, 7:], samples[:, 7:])
        self.assertTrue(torch.all(decoded['root_positions'][:, 1:8, 1].diff(dim=1) > 0))

    def test_action_transition_continues_velocity_instead_of_inserting_a_stop(self):
        # A steady translation/rotation must remain steady across an action
        # boundary when the new inference agrees with the old velocity.
        local = torch.stack([rotation(i * .02) for i in range(16)]).reshape(1, 16, 1, 3, 3).repeat(1, 1, 27, 1, 1)
        root = torch.zeros(1, 16, 3)
        root[0, :, 0] = torch.arange(16) * .05
        motion = self.native(local, root)
        history, future = motion[:, :4].clone(), motion[:, 4:].clone()
        result = blend_action_start(self.rep, history, future, 8)
        torch.testing.assert_close(result, future, atol=2e-6, rtol=2e-6)
        torch.testing.assert_close(history, motion[:, :4])

    def test_single_frame_transition_has_no_invented_velocity(self):
        history = self.native(rotation(.2).repeat(1, 1, 27, 1, 1), torch.tensor([2., 1., 3.]).repeat(1, 1, 1))
        future = self.native(rotation(.8).repeat(1, 12, 27, 1, 1), torch.tensor([3., 1., 4.]).repeat(1, 12, 1))
        result = blend_action_start(self.rep, history, future, 8)
        torch.testing.assert_close(result[:, :1], history)
        torch.testing.assert_close(result[:, 7:], future[:, 7:])

    def test_axis_constraints_keep_height_and_pelvis_rotation_and_correct_native_history(self):
        groups = list(GROUP_JOINTS)
        local = rotation(.4).repeat(1, 4, 27, 1, 1)
        previous_root = torch.tensor([2., .9, -1.]).repeat(1, 4, 1)
        history = self.native(local, previous_root)
        reference = scope_reference(self.rep, groups, history, [False, True, False])
        self.assertEqual(scope_conditions(self.rep, reference, 8), (None, None))
        next_local = rotation(.7).repeat(1, 4, 27, 1, 1)
        moving_root = torch.tensor([4., .3, 5.]).repeat(1, 4, 1)
        samples = torch.cat([history, self.native(next_local, moving_root)], dim=1)
        corrected, decoded = project_scope(self.rep, reference, samples, 4, 4)
        torch.testing.assert_close(decoded["root_positions"][:, :4], previous_root)
        expected = torch.tensor([2., .3, -1.]).repeat(1, 4, 1)
        torch.testing.assert_close(self.rep.inverse(corrected)["root_positions"], expected)
        torch.testing.assert_close(decoded["local_rot_mats"][:, 4:], next_local)
        free = scope_reference(self.rep, groups, history, [True, True, True])
        self.assertEqual(scope_conditions(self.rep, free, 8), (None, None))

    def test_session_rejects_invalid_root_axes(self):
        registry = RollingSessions(20, 8, 4, lambda *_: None, lambda *_: None)
        for axes in [None, [], [False, True], [False, 1, False], [False] * 4]:
            with self.assertRaises(SessionError):
                registry.create({"segments": [{"text": "motion", "duration": 2, "body": ["root"], "rootAxes": axes}]})
        with self.assertRaises(SessionError):
            registry.create({"segments": [{"text": "motion", "duration": 2, "rootAxes": [False, True, False]}]})


if __name__ == "__main__":
    unittest.main()
