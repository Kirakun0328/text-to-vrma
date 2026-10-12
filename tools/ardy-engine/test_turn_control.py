import unittest
import math
import torch
from test_motion_scope import GeometryRep
from turn_control import joint_positions, turn_reference, project_turn, heading
from motion_scope import scope_reference
from rolling_sessions import RollingSessions, SessionError


class TurnTests(unittest.TestCase):
    def setUp(self):
        self.rep = GeometryRep()
        standing = scope_reference(self.rep, [], None)
        self.local = standing['local'].repeat(1, 80, 1, 1, 1)
        self.root = standing['root'].repeat(1, 80, 1)
        self.root[0, :, 0] = torch.linspace(0, .6, 80)
        self.samples = self.rep(self.local, self.root)

    def test_half_turn_anchors_either_foot_and_preserves_limb_articulation(self):
        for pivot in [1, 2]:
            reference = turn_reference(self.rep, self.samples, None, pivot)
            original = self.samples.clone()
            native, decoded = project_turn(self.rep, self.samples, reference, 180, 0, 80)
            torch.testing.assert_close(self.samples, original)
            torch.testing.assert_close(decoded['local_rot_mats'][...,1:,:,:], self.local[...,1:,:,:], atol=2e-6,rtol=2e-6)
            feet = joint_positions(self.rep.skeleton, decoded['local_rot_mats'], decoded['root_positions'])[...,reference['foot'],:]
            torch.testing.assert_close(feet, reference['anchor'].expand_as(feet), atol=2e-6,rtol=2e-6)
            end = heading(decoded['local_rot_mats'],0)[0,-1]
            self.assertAlmostEqual(abs(end.item()),math.pi,places=5)
            torch.testing.assert_close(self.rep.inverse(native)['root_positions'],decoded['root_positions'])

    def test_horizon_partition_and_negative_full_turn_preserve_unwrapped_intent(self):
        reference=turn_reference(self.rep,self.samples,None,0)
        full, decoded=project_turn(self.rep,self.samples,reference,-360,0,80)
        parts=[project_turn(self.rep,self.samples[:,i:i+20],reference,-360,i,80)[0] for i in range(0,80,20)]
        torch.testing.assert_close(torch.cat(parts,dim=1),full)
        yaw=heading(decoded['local_rot_mats'],0)[0]
        deltas=torch.atan2(torch.sin(yaw[1:]-yaw[:-1]),torch.cos(yaw[1:]-yaw[:-1]))
        self.assertAlmostEqual(deltas.sum().item(),-2*math.pi,places=5)
        torch.testing.assert_close(decoded['root_positions'],self.root)

    def test_turn_uses_actual_previous_heading_and_foot(self):
        reference=turn_reference(self.rep,self.samples,None,1)
        prior,_=project_turn(self.rep,self.samples,reference,90,0,80)
        next_ref=turn_reference(self.rep,self.samples,prior,1)
        _,decoded=project_turn(self.rep,self.samples,next_ref,90,0,80)
        self.assertAlmostEqual(abs(heading(decoded['local_rot_mats'],0)[0,-1].item()),math.pi,places=5)
        feet=joint_positions(self.rep.skeleton,decoded['local_rot_mats'],decoded['root_positions'])[...,next_ref['foot'],:]
        torch.testing.assert_close(feet,next_ref['anchor'].expand_as(feet),atol=2e-6,rtol=2e-6)

    def test_session_rejects_invalid_turns_before_generation(self):
        registry=RollingSessions(20,40,4,lambda *args:None,lambda *args:None)
        for turn in [None,[180],[180,3],[True,1],[180,True],[float('nan'),0],[721,0]]:
            with self.assertRaises(SessionError):
                registry.create({'segments':[{'text':'turn','duration':4,'body':['root'],'rootAxes':[True]*3,'turn':turn}]})
        with self.assertRaises(SessionError):
            registry.create({'segments':[{'text':'turn','duration':4,'body':['root'],'rootAxes':[False,True,False],'turn':[180,1]}]})
        meta=registry.create({'segments':[{'text':'turn','duration':4,'body':['root'],'rootAxes':[True]*3,'turn':[180,1]}]})
        self.assertTrue(meta['turnSupported'])


if __name__=='__main__':unittest.main()
