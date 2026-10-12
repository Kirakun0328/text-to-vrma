"""Seeded native inference comparisons; no API calls or running-server mutations."""
import sys, json
from pathlib import Path
workspace = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(workspace / 'tools/ardy-engine'))
sys.argv = ['server.py', '--mini-encoder', str(workspace/'release/ardy-mini-model'), '--no-translate']
import server
server._boot()
if not server.BOOT['ready']:
    raise RuntimeError(server.BOOT)
from rolling_sessions import RollingSessions
directory = workspace/'release/naturalness-before'
directory.mkdir(exist_ok=True)
import motion_scope
current_blend = motion_scope.blend_action_start
all_groups = ['root','torso','head','leftArm','rightArm','leftLeg','rightLeg']
cases = [
 ('wave-locked', 'A person happily waves hello with their right hand.', ['rightArm'], 8),
 ('wave-support', 'A person happily waves hello with their right hand.', ['root','torso','head','rightArm','leftLeg','rightLeg'], 8),
 ('wave-free8', 'A person happily waves hello with their right hand.', all_groups, 8),
 ('wave-free16', 'A person happily waves hello with their right hand.', all_groups, 16),
 ('bow-locked', 'A person shyly bows their upper body forward in thanks.', ['torso','head'], 8),
 ('bow-support', 'A person shyly bows their upper body forward in thanks.', all_groups, 8),
 ('wave-history40', 'A person happily waves hello with their right hand.', ['rightArm'], 8),
 ('wave-support-history40', 'A person happily waves hello with their right hand.', ['root','torso','head','rightArm','leftLeg','rightLeg'], 8),
 ('transition-stopped', 'A person walks forward.', all_groups, 8),
 ('transition-flowing', 'A person walks forward.', all_groups, 8),
]
report={'seed':42,'cases':[]}
for name,text,groups,steps in cases:
 server.seed_everything(42)
 registry=RollingSessions(fps=server.FPS, patch=server.PATCH, horizon_frames=server.model.gen_horizon_len, generate=server._generate_session_chunk, slice_motion=lambda motion,start,end:motion[:,start:end])
 plan={'duration':6,'continuous':True,'segments':[{'text':text,'duration':6,'continuous':not name.endswith('history40'),'body':groups,'rootAxes':[False,True,False]}]}
 if name.startswith('transition-'):
  plan['segments']=[{'text':'A person walks forward.','duration':2,'body':all_groups,'rootAxes':[True,True,True]},
                    {'text':'A person continues walking forward and waves hello with their right hand.','duration':4,'body':all_groups,'rootAxes':[True,True,True]}]
 motion_scope.blend_action_start = (lambda rep, history, samples, frames: current_blend(rep, history[:, -1:], samples, frames)) if name == 'transition-stopped' else current_blend
 meta=registry.create({**plan,'steps':steps,'plannerOwned':True,'planComplete':True})
 sid=meta['sessionId']
 spec={'name':name,'duration':0,'loop':False,'tracks':{},'hips':[]}
 try:
  while True:
   event=registry.next(sid,{})
   for bone,keys in event['tracks'].items():spec['tracks'].setdefault(bone,[]).extend(keys)
   spec['hips'].extend(event['hips']);spec['duration']=event['duration']
   if event['complete']:break
  (directory/(name+'.spec.json')).write_text(json.dumps(spec),encoding='utf8')
  report['cases'].append({'id':name,'status':'passed','specFile':name+'.spec.json','plans':[{'value':plan}]})
  (directory/'results.json').write_text(json.dumps(report),encoding='utf8')
  print('SAVED',name,flush=True)
 finally:registry.close(sid)
