import unittest
import torch
from mini_encoder import ConditionProjection


class ProjectionTests(unittest.TestCase):
    def test_direct_condition_matches_legacy_projection_and_preserves_cfg_bias(self):
        source = torch.randn(2, 1, 4096)
        projections = [torch.nn.Linear(4096, 1024) for _ in range(2)]
        direct = torch.cat([torch.nn.functional.linear(source, p.weight) for p in projections], dim=-1)
        for index, projection in enumerate(projections):
            wrapper = ConditionProjection(projection, index)
            self.assertIs(wrapper.weight, projection.weight)
            self.assertIs(wrapper.bias, projection.bias)
            torch.testing.assert_close(wrapper(source), projection(source))
            torch.testing.assert_close(wrapper(direct), projection(source))
            torch.testing.assert_close(wrapper(torch.zeros_like(direct)), projection(torch.zeros_like(source)))
            with self.assertRaises(ValueError):
                wrapper(torch.zeros(1, 1, 10))
