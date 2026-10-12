"""Offline paired transition experiments. Seeds are evaluation-only."""
import json
from pathlib import Path
import sys
import time
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'release/ardy-transition-eval'
OUT.mkdir(parents=True, exist_ok=True)
sys.path[:0] = ['C:/text-to-motion-ardy-poc/ardy', str(ROOT / 'tools/ardy-engine')]
sys.argv = ['server.py', '--merged-base', 'C:/text-to-motion-ardy-poc/llm2vec-base-merged', '--no-translate']
import server
import torch
server._boot()
if not server.BOOT['ready']:
    raise RuntimeError(server.BOOT['error'])
groups = ['root', 'torso', 'head', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg']
original_encode, original_step = server.model._encode_text, server.model.autoregressive_step
captions = ['A person walks.', 'A person jumps once and lands.', 'A person slowly squats down and stays low.']
with torch.no_grad():
    features = {text: original_encode([text]) for text in captions}
    server.model._encode_text = lambda texts: features[texts[0]]
    report = {'seed': 20260922, 'seedScope': 'Paired evaluation only; no production seed changes.', 'cases': []}
    for target in captions[1:]:
        for variant in ['baseline', 'short', 'pose', 'fresh']:
            used = [False]
            def step(**kwargs):
                history = kwargs['init_history_sequence']
                if kwargs['text_feat'] is features[target][0] and not used[0] and history is not None:
                    used[0] = True
                    old_length = history.shape[1]
                    shortened = history[:, -server.PATCH:]
                    if variant == 'pose':
                        decoded = server.model.motion_rep.inverse(history[:, -1:], is_normalized=True)
                        shortened = server.model.motion_rep(decoded['local_rot_mats'].expand(-1, server.PATCH, -1, -1, -1),
                            decoded['root_positions'].expand(-1, server.PATCH, -1), to_normalize=True)
                    if variant in ['short', 'pose']:
                        kwargs.update(init_history_sequence=shortened, num_frames=server.PATCH + server.model.gen_horizon_len)
                        result = original_step(**kwargs)
                        return torch.cat([history, result[:, server.PATCH:]], dim=1)
                    if variant == 'fresh':
                        _, position, heading = server.model._encode_init_history(history, 1)
                        kwargs.update(init_history_sequence=None, num_frames=server.model.gen_horizon_len,
                            init_global_translation=position, init_first_heading_angle=heading)
                        return torch.cat([history, original_step(**kwargs)], dim=1)
                return original_step(**kwargs)
            server.model.autoregressive_step = step
            torch.manual_seed(report['seed']); torch.cuda.manual_seed_all(report['seed'])
            registry = server._rolling_sessions()
            segments = [{'text': captions[0], 'duration': 3.6, 'continuous': True, 'body': groups},
                        {'text': target, 'duration': 2.4, 'continuous': False, 'body': groups}]
            sid = registry.create({'segments': segments, 'duration': 6, 'steps': 8, 'plannerOwned': True})['sessionId']
            name = ('jump-' if target == captions[1] else 'squat-') + variant
            spec = {'name': name, 'duration': 0, 'loop': False, 'tracks': {}, 'hips': []}
            began = time.perf_counter()
            while True:
                event = registry.next(sid)
                for bone, keys in event['tracks'].items(): spec['tracks'].setdefault(bone, []).extend(keys)
                spec['hips'].extend(event['hips']); spec['duration'] = event['duration']
                if event['complete']: break
            decoded = server.model.motion_rep.inverse(registry.sessions[sid].motion, is_normalized=True)
            root = decoded['root_positions'][0, 72:]
            feet = [server.model.motion_rep.skeleton.bone_order_names.index(n) for n in ['LeftFoot', 'RightFoot']]
            positions = decoded['posed_joints'][0, 72:, feet, 1]
            entry = {'id': name, 'status': 'passed', 'specFile': name + '.spec.json',
                'plans': [{'value': {'segments': segments}}], 'elapsedMs': (time.perf_counter() - began) * 1000,
                'hipRange': (root.max(0).values - root.min(0).values).tolist(),
                'bothFeetMaxHeight': float(positions.min(-1).values.max()),
                'hipStartEnd': [float(root[0, 1]), float(root[-1, 1])]}
            (OUT / entry['specFile']).write_text(json.dumps(spec), encoding='utf-8')
            report['cases'].append(entry)
            (OUT / 'results.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
            print(json.dumps(entry), flush=True)
            registry.close(sid)
