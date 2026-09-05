import { Matrix4, Quaternion, Vector3 } from 'three';

const yaw=q=>{const v=new Vector3(0,0,1).applyQuaternion(q);return Math.atan2(v.x,v.z);};
export function prepareContinuousLoop(source,hipsName) {
  const duration=source.duration;
  if(!Number.isFinite(duration)||duration<.25)return {clip:source,state:null};
  const blend=Math.min(.45,duration*.15),period=duration-blend;
  const positionName=`${hipsName}.position`,rotationName=`${hipsName}.quaternion`;
  const root=source.tracks.find(t=>t.name===positionName)?.createInterpolant();
  const rotation=source.tracks.find(t=>t.name===rotationName)?.createInterpolant();
  const first=root?new Vector3().fromArray(root.evaluate(0)):new Vector3();
  const last=root?new Vector3().fromArray(root.evaluate(duration)):first.clone();
  const qFirst=rotation?new Quaternion().fromArray(rotation.evaluate(0)):new Quaternion();
  const qLast=rotation?new Quaternion().fromArray(rotation.evaluate(duration)):qFirst.clone();
  const turn=Math.atan2(Math.sin(yaw(qLast)-yaw(qFirst)),Math.cos(yaw(qLast)-yaw(qFirst)));
  const traveling=Math.hypot(last.x-first.x,last.z-first.z)>.35||Math.abs(turn)>.35;
  const heading=new Quaternion().setFromAxisAngle(new Vector3(0,1,0),traveling?turn:0);
  const offset=traveling?last.clone().sub(first.clone().applyQuaternion(heading)):new Vector3();offset.y=0;
  const step=new Matrix4().compose(offset,heading,new Vector3(1,1,1));
  const state={cycles:0,traveling};let cachedCycles=NaN,transform=new Matrix4(),cycleRotation=new Quaternion();
  function updateTransform(){
    if(cachedCycles===state.cycles)return;
    cachedCycles=state.cycles;transform.identity();let n=Math.abs(state.cycles),power=step.clone();
    if(state.cycles<0)power.invert();
    while(n>0){if(n%2)transform.multiply(power);power.multiply(power.clone());n=Math.floor(n/2);}
    cycleRotation.setFromRotationMatrix(transform);
  }
  const clip=source.clone();
  clip.tracks=source.tracks.map(track=>{
    const size=track.getValueSize(),isQuat=track.ValueTypeName==='quaternion';
    const interp=track.createInterpolant();
    const frames=Math.ceil(duration*60);
    const times=Array.from({length:frames+1},(_,i)=>duration*i/frames);
    const values=[];
    for(const t of times){
      const u=t*period/duration;
      const a=Array.from(interp.evaluate(Math.min(duration,u+blend)));
      if(u>period-blend){
        const b=Array.from(interp.evaluate(u-(period-blend)));
        if(track.name===positionName){const p=new Vector3().fromArray(b).applyQuaternion(heading).add(offset);p.toArray(b);}
        if(track.name===rotationName)new Quaternion().fromArray(b).premultiply(heading).toArray(b);
        const f=(u-(period-blend))/blend,w=f*f*(3-2*f);
        if(isQuat)new Quaternion().fromArray(a).slerp(new Quaternion().fromArray(b),w).toArray(a);
        else for(let j=0;j<size;j++)a[j]+=(b[j]-a[j])*w;
      }
      values.push(...a);
    }
    const out=new track.constructor(track.name,times,values);
    if(traveling&&(track.name===positionName||track.name===rotationName)) {
      const factory=out.createInterpolant;
      out.createInterpolant=function(resultBuffer){
        const base=factory.call(this),buffer=resultBuffer??new Float32Array(size);
        return {resultBuffer:buffer,evaluate(t){
          const buffer=this.resultBuffer;
          buffer.set(base.evaluate(t));updateTransform();
          if(track.name===positionName)new Vector3().fromArray(buffer).applyMatrix4(transform).toArray(buffer);
          else new Quaternion().fromArray(buffer).premultiply(cycleRotation).toArray(buffer);
          return buffer;
        }};
      };
    }
    return out;
  });
  return {clip,state};
}
