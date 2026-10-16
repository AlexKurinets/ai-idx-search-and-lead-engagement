import os
import sys
from pathlib import Path

os.environ.setdefault("SIM_TICK_SECONDS", "0")
os.environ.setdefault("SIM_SCALE", "0.01")
os.environ.setdefault("RATE_LIMITS", "ECM=1000,BVM=1000,HMR=1000")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
