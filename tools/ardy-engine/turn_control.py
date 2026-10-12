"""Explicit heading and single-foot pivot constraints, not motion templates.

Applied to native future samples and re-encoded into the next inference's
history. Limb articulation remains model-generated; no contact is inferred
from text here. A pivot fixes the foot joint position, not the full shoe sole.
"""
import math
import torch


def joint_positions(skeleton, local, root):
    neutral = skeleton.neutral_joints.to(device=local.device, dtype=local.dtype)
    parents = skeleton.joint_parents.tolist()
    positions, rotations = [], []
    for i, parent in enumerate(parents):
        if parent < 0:
            positions.append(root)
            rotations.append(local[..., i, :, :])
        else:
            positions.append(positions[parent] + (rotations[parent] @ (neutral[i] - neutral[parent])[..., None]).squeeze(-1))
            rotations.append(rotations[parent] @ local[..., i, :, :])
    return torch.stack(positions, dim=-2)


def heading(local, root_index):
    forward = local[..., root_index, :, 2]
    return torch.atan2(forward[..., 0], forward[..., 2])


def turn_reference(rep, samples, previous, pivot):
    pose = rep.inverse(previous[:, -1:] if previous is not None and previous.shape[1] else samples[:, :1], is_normalized=True)
    skeleton = rep.skeleton
    foot = skeleton.bone_order_names.index('LeftFoot' if pivot == 1 else 'RightFoot') if pivot else None
    return {'heading': heading(pose['local_rot_mats'], skeleton.root_idx), 'foot': foot,
            'anchor': joint_positions(skeleton, pose['local_rot_mats'], pose['root_positions'])[..., foot, :] if foot is not None else None}


def project_turn(rep, samples, reference, angle, frame_start, frame_count):
    decoded = rep.inverse(samples, is_normalized=True)
    local, root = decoded['local_rot_mats'].clone(), decoded['root_positions'].clone()
    # Absolute segment-relative frame indices make the result independent of
    # horizon boundaries; even multi-revolution turns do not take a short arc.
    phase = torch.arange(frame_start, frame_start + samples.shape[1], device=samples.device, dtype=samples.dtype) / max(1, frame_count - 1)
    phase = phase.clamp(0, 1)
    phase = phase * phase * (3 - 2 * phase)
    target = reference['heading'] + math.radians(angle) * phase[None, :]
    delta = target - heading(local, rep.skeleton.root_idx)
    c, s = torch.cos(delta), torch.sin(delta)
    zero, one = torch.zeros_like(c), torch.ones_like(c)
    yaw = torch.stack([c, zero, s, zero, one, zero, -s, zero, c], dim=-1).reshape(*delta.shape, 3, 3)
    local[..., rep.skeleton.root_idx, :, :] = yaw @ local[..., rep.skeleton.root_idx, :, :]
    if reference['foot'] is not None:
        foot = joint_positions(rep.skeleton, local, root)[..., reference['foot'], :]
        root += reference['anchor'] - foot
    corrected = rep(local, root, to_normalize=True)
    return corrected, rep.inverse(corrected, is_normalized=True)
