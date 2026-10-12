"""Physical ownership of generated joints; no motion or gesture templates.

ARDY owns only the groups selected by the motion planner. Other local joint
rotations retain their actual pose at the start of that segment. ``root`` owns
both pelvis rotation and root translation; optional root_axes independently
limits world-space translation without freezing pelvis rotation. A fresh session starts from the
skeleton's standing rest geometry, with the upper arms aligned with gravity.
All corrections are re-encoded into native ARDY features before reuse as
history, so the next inference sees the pose that was actually emitted.
"""

import os

import torch


def blend_action_start(motion_rep, previous, samples, frames):
    """Join a freshly inferred action to the actual last pose, not its behavior.

    Blend only future samples and re-encode them for the next native step.
    No fixed gesture or standing pose is introduced.
    """
    from scipy.spatial.transform import Rotation
    old = motion_rep.inverse(previous[:, -2:], is_normalized=True)
    new = motion_rep.inverse(samples, is_normalized=True)
    local, root = new['local_rot_mats'].clone(), new['root_positions'].clone()
    count = min(frames, samples.shape[1])
    if count < 2:
        return samples
    weight = torch.linspace(0, 1, count, device=samples.device, dtype=samples.dtype)
    weight = weight * weight * (3 - 2 * weight)
    # The first new frame is one timestep AFTER the last history frame. Using
    # the last pose for the whole blend duplicated that frame, killed velocity
    # at every action boundary, then accelerated abruptly toward the new clip.
    # Continue the observed local angular/root velocity through the fade.
    last = old['local_rot_mats'][:, -1:]
    before = old['local_rot_mats'][:, -2:-1] if previous.shape[1] > 1 else last
    a0 = Rotation.from_matrix(last.detach().cpu().reshape(-1, 3, 3).numpy())
    a_prev = Rotation.from_matrix(before.detach().cpu().reshape(-1, 3, 3).numpy())
    velocity = (a_prev.inv() * a0).as_rotvec().reshape(last.shape[0], 1, last.shape[2], 3)
    steps = torch.arange(1, count + 1, device=samples.device, dtype=samples.dtype)
    extrapolated = velocity * steps.cpu().numpy()[None, :, None, None]
    anchor = Rotation.from_matrix(last.expand(-1, count, -1, -1, -1).detach().cpu().reshape(-1, 3, 3).numpy())
    start = (anchor * Rotation.from_rotvec(extrapolated.reshape(-1, 3))).as_matrix()
    target = local[:, :count]
    a = Rotation.from_matrix(start)
    b = Rotation.from_matrix(target.detach().cpu().reshape(-1, 3, 3).numpy())
    scale = weight[None, :, None].expand(*target.shape[:3]).reshape(-1, 1).cpu().numpy()
    mixed = (a * Rotation.from_rotvec((a.inv() * b).as_rotvec() * scale)).as_matrix()
    local[:, :count] = torch.as_tensor(mixed, device=samples.device, dtype=samples.dtype).reshape(target.shape)
    last_root = old['root_positions'][:, -1:]
    before_root = old['root_positions'][:, -2:-1] if previous.shape[1] > 1 else last_root
    continuing_root = last_root + steps[None, :, None] * (last_root - before_root)
    root[:, :count] = continuing_root + weight[None, :, None] * (root[:, :count] - continuing_root)
    return motion_rep(local, root, to_normalize=True)


GROUP_JOINTS = {
    "root": {"Hips"},
    "torso": {"Spine", "Spine1", "Spine2", "Spine3"},
    "head": {"Neck", "Head"},
    "leftArm": {"LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand", "LeftHandEnd", "LeftHandThumb1"},
    "rightArm": {"RightShoulder", "RightArm", "RightForeArm", "RightHand", "RightHandEnd", "RightHandThumb1"},
    "leftLeg": {"LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase"},
    "rightLeg": {"RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"},
}


def _align_direction(source, target):
    """Shortest rotation between two non-opposed unit vectors."""
    source = source / source.norm()
    target = target / target.norm()
    cross = torch.linalg.cross(source, target)
    x, y, z = cross.unbind()
    zero = torch.zeros_like(x)
    skew = torch.stack([zero, -z, y, z, zero, -x, -y, x, zero]).reshape(3, 3)
    cosine = (source * target).sum()
    if cosine < -0.999:
        raise ValueError("standing rest arm direction cannot oppose gravity")
    return torch.eye(3, device=source.device, dtype=source.dtype) + skew + skew @ skew / (1 + cosine)


def scope_reference(motion_rep, groups, history, root_axes=None):
    """Capture once per segment; callers preserve this reference across chunks."""
    skeleton = motion_rep.skeleton
    names = skeleton.bone_order_names
    supported = set().union(*GROUP_JOINTS.values())
    if set(names) != supported:
        raise ValueError("body ownership requires the supported humanoid skeleton")
    device = skeleton.neutral_joints.device
    # Skeleton assets are float64, while ARDY's encoder/denoiser runs float32.
    dtype = history.dtype if history is not None else torch.float32
    owned_names = set().union(*(GROUP_JOINTS[group] for group in groups)) if groups else set()
    owned = torch.tensor([name in owned_names for name in names], dtype=torch.bool, device=device)
    if history is not None and history.shape[1]:
        pose = motion_rep.inverse(history[:, -1:], is_normalized=True)
        local, root = pose["local_rot_mats"][:, -1:].clone(), pose["root_positions"][:, -1:].clone()
    else:
        local = torch.eye(3, device=device, dtype=dtype).repeat(1, 1, len(names), 1, 1)
        down = torch.tensor([0., -1., 0.], device=device, dtype=dtype)
        joints = skeleton.neutral_joints.to(dtype=dtype)
        for side in ["Left", "Right"]:
            upper, lower = names.index(side + "Arm"), names.index(side + "ForeArm")
            local[0, 0, upper] = _align_direction(joints[lower] - joints[upper], down)
        root = torch.zeros(1, 1, 3, device=device, dtype=dtype)
        # Retargeted VRMA uses the ankle/Foot baseline. ToeBase endpoints are
        # below that baseline in the core rest asset and are not exported.
        foot_indices = [names.index(name) for name in ["LeftFoot", "RightFoot"]]
        root[..., 1] = joints[skeleton.root_idx, 1] - joints[foot_indices, 1].min()
    locks = [not value for value in (root_axes or [True, True, True])] if "root" in groups else [True] * 3
    return {"local": local, "root": root, "owned": owned,
            "owns_root": "root" in groups,
            "root_locks": torch.tensor(locks, dtype=torch.bool, device=device),
            "hanging": _hanging_arms(skeleton, local, owned)}


# Every foot point this far above the session's floor means the pose is airborne.
AIRBORNE_M = 0.05


def is_airborne(motion_rep, history):
    """Whether the last emitted pose has no foot (ankle or toe) on the floor.

    The floor is the lowest foot point seen so far in this session, so heels
    lifted in a squat or on tiptoe still count as grounded through the toes.
    """
    if history is None or history.shape[1] < 2:
        return False
    skeleton = motion_rep.skeleton
    names = skeleton.bone_order_names
    feet = [names.index(name) for name in ["LeftFoot", "RightFoot", "LeftToeBase", "RightToeBase"]]
    past = motion_rep.inverse(history, is_normalized=True)
    heights = _joint_positions(skeleton, past["global_rot_mats"], past["root_positions"])[..., feet, 1]
    return bool(heights[:, -1].min() - heights.min() > AIRBORNE_M)


def airborne_scope(scope, root_axes):
    """Let a segment that starts mid-air land instead of freezing the jump.

    Holding the pelvis height floats the character; holding the legs while
    forcing the height down leaves a tucked crouch. Vertical pelvis motion and
    the legs are enabled, while unowned horizontal travel stays locked.
    """
    scope = list(scope)
    if "root" in scope:
        axes = list(root_axes) if root_axes is not None else None
        if axes is not None:
            axes[1] = True
    else:
        scope.append("root")
        axes = [False, True, False]
    for group in ["leftLeg", "rightLeg"]:
        if group not in scope:
            scope.append(group)
    return scope, axes


# Largest per-frame change of the hand/floor guard blend weight.
GUARD_RATE = 0.12

# An upper arm within this angle of gravity counts as lowered/hanging.
HANG_LIMIT_DEG = 45.0


def _global_rotations(skeleton, local):
    glob = local.clone()
    for index, parent in enumerate(skeleton.joint_parents.tolist()):
        if parent >= 0:
            glob[..., index, :, :] = glob[..., parent, :, :] @ local[..., index, :, :]
    return glob


def _joint_positions(skeleton, glob, root):
    """World joint positions from global rotations and the root position."""
    offsets = skeleton.neutral_joints.to(dtype=glob.dtype)
    parents = skeleton.joint_parents.tolist()
    positions = [None] * len(parents)
    for index, parent in enumerate(parents):
        if parent < 0:
            positions[index] = root
        else:
            bone = (offsets[index] - offsets[parent]).to(glob.device)
            positions[index] = positions[parent] + (glob[..., parent, :, :] @ bone.unsqueeze(-1)).squeeze(-1)
    return torch.stack(positions, dim=-2)


def _yaw(skeleton, glob, chest):
    """Heading of the arms' carrier (shoulder parent), ignoring its lean."""
    names = skeleton.bone_order_names
    offsets = skeleton.neutral_joints
    lateral = (offsets[names.index("LeftShoulder")] - offsets[names.index("RightShoulder")]).to(glob)
    if lateral.norm() < 1e-6:
        lateral = torch.tensor([1., 0., 0.], device=glob.device, dtype=glob.dtype)
    world = (glob[..., chest, :, :] @ lateral.unsqueeze(-1)).squeeze(-1)
    return torch.atan2(-world[..., 2], world[..., 0])


def _rotation_y(angle):
    c, s = torch.cos(angle), torch.sin(angle)
    zero, one = torch.zeros_like(angle), torch.ones_like(angle)
    return torch.stack([c, zero, s, zero, one, zero, -s, zero, c], dim=-1).reshape(*angle.shape, 3, 3)


def _hanging_arms(skeleton, local, owned):
    """Unowned upper arms that were lowered when the segment began."""
    names = skeleton.bone_order_names
    glob = _global_rotations(skeleton, local)
    down = torch.tensor([0., -1., 0.], device=local.device, dtype=local.dtype)
    result = {}
    for side in ["Left", "Right"]:
        upper, lower = names.index(side + "Arm"), names.index(side + "ForeArm")
        if owned[upper]:
            continue
        bone = (skeleton.neutral_joints[lower] - skeleton.neutral_joints[upper]).to(local)
        direction = glob[0, -1, upper] @ (bone / bone.norm())
        angle = torch.rad2deg(torch.acos((direction * down).sum().clamp(-1, 1)))
        if angle <= HANG_LIMIT_DEG:
            chest = skeleton.joint_parents.tolist()[skeleton.joint_parents.tolist()[upper]]
            result[side] = {"global": glob[:, -1:, upper].clone(), "yaw": _yaw(skeleton, glob[:, -1:], chest)}
    return result


def arms_not_lowered(motion_rep, history, groups):
    """Arm groups whose upper arm is not hanging in the last emitted pose."""
    if history is None or not history.shape[1]:
        return []  # A fresh session starts from the anatomical arms-down rest.
    skeleton = motion_rep.skeleton
    local = motion_rep.inverse(history[:, -1:], is_normalized=True)["local_rot_mats"]
    hanging = _hanging_arms(skeleton, local, torch.zeros(len(skeleton.bone_order_names), dtype=torch.bool, device=local.device))
    return [group for group in groups if group[:-3].capitalize() not in hanging]


def _keep_hanging(skeleton, reference, local, root, start):
    """Let lowered, unowned arms keep hanging under gravity while the torso leans.

    Holding their local rotation would swing them forward with a bow or squat
    and freeze that unrequested pose. They still turn with the chest heading,
    so walking or turning never leaves the arms behind in world space. The hand
    is never pushed below the ankles; there the local hold is blended back in.
    """
    hanging = reference.get("hanging") or {}
    # ARDY_KEEP_HANGING=0 restores the plain local hold (for A/B evaluation).
    if not hanging or local.shape[1] <= start or os.environ.get("ARDY_KEEP_HANGING", "1") == "0":
        return local
    names = skeleton.bone_order_names
    parents = skeleton.joint_parents.tolist()
    feet = [names.index("LeftFoot"), names.index("RightFoot")]
    for side, held in hanging.items():
        upper = names.index(side + "Arm")
        hand = names.index(side + "Hand")
        glob = _global_rotations(skeleton, local[:, start:])
        chest = parents[parents[upper]]
        turn = _rotation_y(_yaw(skeleton, glob, chest) - held["yaw"])
        target = turn @ held["global"]
        hang = glob[..., parents[upper], :, :].transpose(-1, -2) @ target
        hold = local[:, start:, upper]
        candidate = local[:, start:].clone()
        candidate[:, :, upper] = hang
        positions = _joint_positions(skeleton, _global_rotations(skeleton, candidate), root[:, start:])
        floor = positions[..., feet, 1].min(dim=-1).values
        below = positions[..., hand, 1] < floor
        if below.any():
            # Blend toward the held local pose just enough for the hand to
            # clear the ankles. A per-frame bisection keeps the weight
            # continuous; coarse steps made the arm jitter between frames.
            low = torch.zeros(below.shape, device=local.device, dtype=local.dtype)
            high = torch.ones_like(low)
            for _ in range(12):
                weight = (low + high) / 2
                trial = candidate.clone()
                trial[:, :, upper] = _blend(hold, hang, weight)
                positions = _joint_positions(skeleton, _global_rotations(skeleton, trial), root[:, start:])
                clear = positions[..., hand, 1] >= positions[..., feet, 1].min(dim=-1).values
                low = torch.where(clear, weight, low)
                high = torch.where(clear, high, weight)
            # Near vertical, a few centimetres of hand height need a large arm
            # angle, so a hard per-frame limit turned contact into a one-frame
            # pop. Ease into (and out of) the limit within the generated window:
            # the weight may change by at most GUARD_RATE per frame.
            weight = torch.where(below, low, torch.ones_like(low))
            steps = torch.arange(weight.shape[-1], device=weight.device, dtype=weight.dtype)
            distance = (steps[:, None] - steps[None, :]).abs() * GUARD_RATE
            weight = (weight[..., None, :] + distance).min(dim=-1).values.clamp(max=1)
            hang = _blend(hold, hang, weight)
        local[:, start:, upper] = hang
    return local


def _blend(a, b, weight):
    """Rotation-matrix interpolation from a (0) to b (1)."""
    relative = a.transpose(-1, -2) @ b
    cosine = ((relative.diagonal(dim1=-2, dim2=-1).sum(-1) - 1) / 2).clamp(-1 + 1e-6, 1 - 1e-6)
    angle = torch.acos(cosine)
    axis = torch.stack([relative[..., 2, 1] - relative[..., 1, 2], relative[..., 0, 2] - relative[..., 2, 0],
                        relative[..., 1, 0] - relative[..., 0, 1]], dim=-1)
    axis = axis / (2 * torch.sin(angle)).clamp_min(1e-6).unsqueeze(-1)
    theta = (angle * weight).unsqueeze(-1).unsqueeze(-1)
    x, y, z = axis.unbind(-1)
    zero = torch.zeros_like(x)
    skew = torch.stack([zero, -z, y, z, zero, -x, -y, x, zero], dim=-1).reshape(*x.shape, 3, 3)
    eye = torch.eye(3, device=a.device, dtype=a.dtype).expand_as(skew)
    step = eye + torch.sin(theta) * skew + (1 - torch.cos(theta)) * (skew @ skew)
    return a @ step


def scope_conditions(motion_rep, reference, frame_count):
    """Condition only a held root; enforce local joint ownership after decoding.

    Dense full-window rotation constraints suppress even unconstrained moving
    limbs in the native model. Ownership is a local-channel requirement, not a
    request to infill nearly every world-space pose throughout the performance.
    Root position/heading are native trajectory conditions; limb ownership is
    enforced by project_scope and carried into the next physical history.
    """
    # When the pelvis is moving, dense fixed trajectory hints can suppress the
    # requested limb motion too. Enforce permitted translation axes only in
    # project_scope, then feed that corrected motion back as native history.
    if reference["owns_root"]:
        return None, None
    local = reference["local"].expand(-1, frame_count, -1, -1, -1)
    root = reference["root"].expand(-1, frame_count, -1)
    observed = motion_rep(local, root, to_normalize=True)
    mask = torch.zeros_like(observed)
    mask[..., motion_rep.slice_dict["root_pos"]] = reference["root_locks"].to(mask.dtype)
    if not reference["owns_root"]:
        mask[..., motion_rep.slice_dict["global_root_heading"]] = 1
    return observed * mask, mask


def project_scope(motion_rep, reference, samples, history_length, keep):
    """Hold unowned local channels and return matching decoded/native motion."""
    length = history_length + keep
    decoded = motion_rep.inverse(samples[:, :length], is_normalized=True)
    local, root = decoded["local_rot_mats"].clone(), decoded["root_positions"].clone()
    local[:, history_length:, ~reference["owned"]] = reference["local"][:, :, ~reference["owned"]]
    locked = reference["root_locks"]
    root[:, history_length:, locked] = reference["root"][:, :, locked]
    local = _keep_hanging(motion_rep.skeleton, reference, local, root, history_length)
    # Recompute positions, velocities, contacts and heading from the corrected
    # skeleton. Never retain an uncorrected latent/sample behind a filtered view.
    corrected = motion_rep(local, root, to_normalize=True)
    decoded = motion_rep.inverse(corrected, is_normalized=True)
    return corrected[:, history_length:], decoded
