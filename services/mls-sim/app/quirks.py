"""How each invented MLS deviates from the RESO Data Dictionary on the wire.

Real feeds are rarely pure Data Dictionary. These three deviations are the kinds the
replicator's per-MLS mapping files exist to absorb:

ECM  canonical field names and enumerations.
BVM  enumeration display names ("Active Under Contract"), prices as strings, and the
     neighborhood in a local field instead of SubdivisionName.
HMR  no LivingArea or BathroomsTotalInteger (a local square-footage field and the
     full/half counts instead), "Townhome" for Townhouse, and some under-contract
     listings carry a non-standard "Contingent" status.
"""

from __future__ import annotations

import hashlib
from datetime import datetime
from typing import Any

from .odata import format_datetime

Record = dict[str, Any]

_BVM_STATUS = {"ActiveUnderContract": "Active Under Contract", "ComingSoon": "Coming Soon"}
_BVM_SUBTYPE = {"SingleFamilyResidence": "Single Family Residence"}


def _stable_fraction(key: str) -> float:
    return int(hashlib.sha1(key.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


def render(mls: str, rec: Record) -> Record:
    out: Record = {}
    for k, v in rec.items():
        out[k] = format_datetime(v) if isinstance(v, datetime) else v

    if mls == "BVM":
        out["StandardStatus"] = _BVM_STATUS.get(out["StandardStatus"], out["StandardStatus"])
        out["PropertySubType"] = _BVM_SUBTYPE.get(out["PropertySubType"], out["PropertySubType"])
        for f in ("ListPrice", "OriginalListPrice", "ClosePrice"):
            if out.get(f) is not None:
                out[f] = f"{out[f]:.2f}"
        out["BVM_NeighborhoodName"] = out.pop("SubdivisionName")
    elif mls == "HMR":
        out["HMR_TotalFinishedSqFt"] = out.pop("LivingArea")
        out.pop("LivingAreaUnits", None)
        out.pop("BathroomsTotalInteger", None)
        if out["PropertySubType"] == "Townhouse":
            out["PropertySubType"] = "Townhome"
        if out["StandardStatus"] == "ActiveUnderContract" and _stable_fraction(out["ListingKey"]) < 0.4:
            out["StandardStatus"] = "Contingent"
    return out

