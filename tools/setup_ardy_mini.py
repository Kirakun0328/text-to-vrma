"""Download only the pinned MiniLM conditioning graph; retain native ARDY motion."""
import gzip
import hashlib
from pathlib import Path
from urllib.request import urlopen

REVISION = '1c21362effeecec0454bfc0d818661525ae6b387'
BASE = f'https://huggingface.co/intsuc/Llama-3-ARDY-Mini-Core40-Browser/resolve/{REVISION}/'
DEST = Path(__file__).resolve().parents[1] / 'release' / 'ardy-mini-model'
FILES = {
    'LICENSES/APACHE-2.0.txt': 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
    'LICENSES/CC-BY-4.0.txt': '9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411',
    'LICENSES/LLM2VEC-MIT.txt': 'e69268828e67ffd1d3393a2d3530f97df6deaa0b961039fc971abea28cec8715',
    'LICENSES/META_LLAMA_3_COMMUNITY_LICENSE.txt': '4fa551d4f938f68b8c1e6afa9d28befb70e3f33f75d0753248d530364aeea40f',
    'LICENSES/NVIDIA_OPEN_MODEL_LICENSE.txt': '11ccdcb47db87ac30b63765b5e5154403026c4fbb52c19919d99d912ec454e19',
    'MODEL_PROVENANCE.json': '5fd4266caa9f4e3952945d0989aa597064f929db515fec25344cd4f128ffa4df',
    'fp32/model.json.gz': 'f60ae9f4e4e44d632e78a93ba33c4a54167a17a4d1f0d4f2acd21d13bdf36ca0',
    'fp32/text_encoder.onnx.gz': '4d97f7b1deb83752ea93c6b8af3b2f8099ce23d6a43b6a2e43e05d6f58c24fd7',
    'fp32/tokenizer/tokenizer.json.gz': 'ee6f3f1f6e6c7b5fd6b7d62144257cfaaf6d7addd97e756e5bba968f47598d13',
    'fp32/tokenizer/tokenizer_config.json.gz': 'c59567ee18056691739eae7e3fa777ed6d2c344d42e048525d0a235653bf63b6',
    'MODEL_TERMS.md': '6d29c8e1cb241af48ef5dc54a5c1210f455672f38995db6936c48579059f4163',
    'NOTICE': '4326045e6380f00631fd3eae130a4e78e9c11852d7984d8c8d9712d091cb5b4f',
}

if __name__ == '__main__':
    print('Optional model download: Llama 3 ARDY Mini Core40 Browser', flush=True)
    print('Model terms (separate from the application MIT license):', flush=True)
    print(BASE + 'MODEL_TERMS.md', flush=True)
    print('Includes Meta Llama 3 teacher lineage; external model terms apply.', flush=True)
    print('Built with Meta Llama 3. Model notices will be saved with the local files.', flush=True)
    for name, expected in FILES.items():
        print(name, flush=True)
        with urlopen(BASE + name, timeout=120) as response:
            payload = response.read()
        if hashlib.sha256(payload).hexdigest() != expected:
            raise ValueError(f'Checksum mismatch: {name}')
        target = DEST / name.removeprefix('fp32/').removesuffix('.gz')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(gzip.decompress(payload) if name.endswith('.gz') else payload)
    (DEST / 'revision.txt').write_text(REVISION)
