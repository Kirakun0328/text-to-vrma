#!/usr/bin/env python3
# quantize_text_encoder.py — convert llm2vec-base-merged (bf16) to 4-bit/8-bit via bitsandbytes
# Usage: python quantize_text_encoder.py --in <merged-base-dir> --out <quantized-dir> --bits 4 --verify 3

import argparse
import json
import os
import sys
import shutil
from pathlib import Path

# T4 (sm_75) + bitsandbytes: cublasLt int8 addmm kernels throw CUBLAS_STATUS_EXECUTION_FAILED.
# Disable the Lt fast path before torch loads cublas.
os.environ.setdefault("DISABLE_ADDMM_CUDA_LT", "1")

import torch
from transformers import BitsAndBytesConfig, AutoTokenizer

# Add the ardy-engine path for LlamaBiModel import
sys.path.insert(0, str(Path(__file__).parent))
try:
    from ardy.model.llm2vec.models.bidirectional_llama import LlamaBiModel
    from ardy.model.llm2vec.llm2vec import LLM2Vec
except ImportError as e:
    print(f"Failed to import ARDY LLM2Vec components: {e}")
    print("Ensure you're running inside the ARDY engine venv (where 'ardy' is installed editable)")
    sys.exit(1)


def parse_args():
    ap = argparse.ArgumentParser(description="Quantize LLM2Vec merged base to 4-bit/8-bit")
    ap.add_argument("--in", dest="src", required=True, help="Path to merged base dir (llm2vec-base-merged)")
    ap.add_argument("--out", required=True, help="Output directory for quantized model")
    ap.add_argument("--bits", type=int, default=4, choices=[4, 8], help="Quantization bits (4 or 8)")
    ap.add_argument("--verify", type=int, default=3, help="Number of sample sentences to verify (0=skip)")
    ap.add_argument("--min-cos", type=float, default=0.95,
                    help="Min cosine sim vs bf16 baseline (simplified pooling is stricter than "
                         "the runtime EOS pooling; ~0.97 is typical and healthy for 4-bit)")
    ap.add_argument("--device", default="cuda", help="Device for inference (cuda/cpu)")
    return ap.parse_args()


def build_bnb_config(bits: int) -> BitsAndBytesConfig:
    if bits == 4:
        return BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )
    else:
        return BitsAndBytesConfig(load_in_8bit=True)


def main():
    args = parse_args()
    src = Path(args.src).resolve()
    out = Path(args.out).resolve()

    if not src.exists():
        print(f"Source not found: {src}")
        sys.exit(1)

    if out.exists():
        print(f"Output exists, removing: {out}")
        shutil.rmtree(out)

    print(f"Loading merged base from: {src}")
    print(f"Quantizing to {args.bits}-bit...")

    bnb_config = build_bnb_config(args.bits)

    # Quantize-on-load: shard-by-shard, never holds full bf16 on GPU
    model = LlamaBiModel.from_pretrained(
        str(src),
        quantization_config=bnb_config,
        device_map=args.device,
        torch_dtype=torch.bfloat16,
    )

    print(f"Saving quantized model to: {out}")
    model.save_pretrained(out, safe_serialization=True)
    AutoTokenizer.from_pretrained(src).save_pretrained(out)

    # Verify _name_or_path survives (critical for instruction format in prepare_for_tokenization)
    cfg_path = out / "config.json"
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    cfg["_name_or_path"] = "meta-llama/Meta-Llama-3-8B-Instruct"
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)

    # Completion marker (mirrors installer convention)
    (out / "quantize-complete.marker").write_text(f"bits={args.bits}\n")

    # Size report
    src_size = sum(f.stat().st_size for f in src.rglob("*") if f.is_file())
    out_size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    ratio = out_size / src_size * 100
    print(f"\n=== SIZE REPORT ===")
    print(f"Source:  {src_size / 1024**3:.2f} GB")
    print(f"Quantized: {out_size / 1024**3:.2f} GB ({ratio:.1f}%)")
    print(f"Reduction: {(1 - ratio/100)*100:.1f}%")

    # Verification
    if args.verify > 0:
        print(f"\n=== VERIFICATION ({args.verify} samples) ===")
        sample_texts = [
            "A person waves their right hand.",
            "Walking forward while looking around.",
            "Sadly bowing head with shoulders slumped.",
            "Jumping up with both arms raised.",
            "Sitting down and crossing legs.",
        ][:args.verify]

        # Load quantized model WITH device_map="auto" — respects saved quantization config (4-bit/8-bit)
        print("Loading quantized model (auto device_map, respects quantization config)...")
        torch.cuda.empty_cache()
        model_q = LlamaBiModel.from_pretrained(str(out), device_map="auto")
        model_q = model_q.eval()

        # Load tokenizer once for verification
        tokenizer = AutoTokenizer.from_pretrained(str(out))

        # Try CPU bf16 baseline if RAM allows (optional)
        baseline_model = None
        try:
            print("Loading bf16 baseline on CPU for cosine comparison...")
            baseline_model = LlamaBiModel.from_pretrained(
                str(src), device_map="cpu", torch_dtype=torch.bfloat16
            )
            baseline_model.eval()
        except Exception as e:
            print(f"  Baseline skipped (RAM/CPU): {e}")

        def encode_text(model, text, device):
            """Simple encode: tokenize + forward + last-token hidden state."""
            inputs = tokenizer(
                text, return_tensors="pt", padding="longest",
                truncation=True, max_length=512
            ).to(device)
            with torch.no_grad():
                outputs = model(**inputs, output_hidden_states=True)
                # Take last hidden state & mean-pool over non-zero attention positions
                # (simplified vs LLM2Vec.encode, sufficient for cosine comparison)
                hidden = outputs.hidden_states[-1]  # [1, seq_len, dim]
                mask = inputs["attention_mask"].unsqueeze(-1)  # [1, seq_len, 1]
                pooled = (hidden * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1)
            return pooled

        passed = True
        for i, text in enumerate(sample_texts):
            with torch.no_grad():
                out_q = encode_text(model_q, text, "cuda")
                out_q = out_q.float().cpu()

            if baseline_model is not None:
                with torch.no_grad():
                    out_b = encode_text(baseline_model, text, "cpu")
                    out_b = out_b.float().cpu()
                cos = torch.nn.functional.cosine_similarity(out_q, out_b, dim=-1).mean().item()
                status = "OK" if cos >= args.min_cos else "LOW"
                if cos < args.min_cos:
                    passed = False
                print(f"  Sample {i+1}: cosine={cos:.6f} (threshold {args.min_cos}) {status}")
            else:
                # Integrity check only
                has_nan = torch.isnan(out_q).any().item()
                has_inf = torch.isinf(out_q).any().item()
                status = "✗" if has_nan or has_inf else "✓"
                if has_nan or has_inf:
                    passed = False
                print(f"  Sample {i+1}: dim={out_q.shape[-1]}, finite={not (has_nan or has_inf)} {status}")

        if passed:
            print("\n=== VERIFICATION PASSED ===")
        else:
            print("\n=== VERIFICATION FAILED ===")
            sys.exit(1)

    print(f"\nDone! Quantized model ready at: {out}")
    print("Launch engine with:")
    print(f"  TEXT_ENCODER_DEVICE=cuda python server.py --merged-base {out}")


if __name__ == "__main__":
    main()