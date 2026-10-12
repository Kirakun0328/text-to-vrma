"""ARDY-mini's published ONNX conditioner with the native constrained denoiser.

Reference: https://github.com/intsuc/ardy-mini (Apache-2.0).
Model artifacts have separate composite terms, retained by setup_ardy_mini.py.
"""
import hashlib
import json
from pathlib import Path

import numpy as np
import torch
from torch import nn

MODEL = 'ARDY-Core-RP-20FPS-Horizon40'


def verify_file(path, expected):
    with Path(path).open('rb') as stream:
        actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    if actual != expected:
        raise ValueError(f'ARDY-mini checksum mismatch: {Path(path).name}')


class MiniEncoder(nn.Module):
    output_dim = 2048

    def __init__(self, directory):
        super().__init__()
        import onnxruntime as ort
        from tokenizers import Tokenizer
        directory = Path(directory)
        self.manifest = json.loads((directory / 'model.json').read_text())
        for name in ['text_encoder.onnx', 'tokenizer/tokenizer.json']:
            verify_file(directory / name, self.manifest['files'][name]['sha256'])
        self.tokenizer = Tokenizer.from_file(str(directory / 'tokenizer/tokenizer.json'))
        self.max_length = self.manifest['tokenizer']['max_length']
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        self.session = ort.InferenceSession(str(directory / 'text_encoder.onnx'), options,
                                            providers=['CPUExecutionProvider'])

    def forward(self, texts):
        features = []
        for text in texts:
            encoded = self.tokenizer.encode(text)
            if len(encoded.ids) > self.max_length:
                raise ValueError('ARDY-mini caption exceeds 128 tokens; refusing to drop requested actions')
            inputs = {'input_ids': np.array([encoded.ids], dtype=np.int64),
                      'attention_mask': np.array([encoded.attention_mask], dtype=np.int64),
                      'token_type_ids': np.array([encoded.type_ids], dtype=np.int64)}
            output = self.session.run(['text_conditions'], inputs)[0]
            if output.shape != (1, 1, 2048) or not np.isfinite(output).all():
                raise ValueError('Invalid ARDY-mini conditioning output')
            features.append(torch.from_numpy(output.copy()))
        return torch.cat(features), [1] * len(features)


class ConditionProjection(nn.Module):
    """Retain legacy projection and CFG bias; direct conditions exclude that bias."""
    def __init__(self, original, index):
        super().__init__()
        self.original = original
        self.index = index
        self.in_features, self.out_features = original.in_features, original.out_features

    @property
    def weight(self):
        return self.original.weight

    @property
    def bias(self):
        return self.original.bias

    def forward(self, value):
        if value.shape[-1] == self.in_features:
            return self.original(value)
        if value.shape[-1] != self.out_features * 2:
            raise ValueError('Incompatible ARDY-mini condition width')
        start = self.index * self.out_features
        selected = value[..., start:start + self.out_features]
        return selected + self.original.bias if self.original.bias is not None else selected


def attach_mini(model, encoder, model_name):
    if model_name != MODEL:
        raise ValueError('ARDY-mini supports Core40 only')
    stages = [model.denoiser.model.root_model, model.denoiser.model.body_model]
    # Distillation is specific to these exact bias-free projection weights.
    from huggingface_hub import hf_hub_download
    from safetensors import safe_open
    reference = hf_hub_download('nvidia/' + MODEL, 'denoiser.safetensors', local_files_only=True)
    verify_file(reference, encoder.manifest['model']['ardy_checkpoint']['files']['denoiser.safetensors']['sha256'])
    with safe_open(reference, framework='pt', device='cpu') as weights:
        for name, stage in zip(['root_model', 'body_model'], stages):
            expected = weights.get_tensor(f'denoiser.backbone.{name}.embed_text.weight')
            if not torch.equal(stage.embed_text.weight.detach().cpu(), expected):
                raise ValueError('ARDY-mini checkpoint projection mismatch')
    for stage in stages:
        if stage.embed_text.in_features != 4096 or stage.embed_text.out_features != 1024:
            raise ValueError('Incompatible ARDY-mini projection')
    for index, stage in enumerate(stages):
        stage.embed_text = ConditionProjection(stage.embed_text, index)
    model.text_encoder = encoder
