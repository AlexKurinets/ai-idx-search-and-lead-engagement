"""Seeds the synthetic brokerage group and drives live leads through the real pipeline.

1. Waits for the replicator to finish its backfill from the synthetic MLS feeds.
2. Writes the static data directly: 12 offices, 25 agents each, 3 farm areas per office,
   about 200 contacts per office with 90 days of engagement history and saved searches.
3. Sends about 120 live web inquiries through the public API. Scripted buyers answer
   the texting engine through the sandbox handset (signed webhooks), so first-response
   times, qualification, bookings and hand-offs are produced by the running system.
4. Registers saved-search percolators, scores every contact, drafts and sends farm
   reports, and runs a batch of natural-language searches so the dashboards have data.

Everything here is invented: names, places, phone numbers (555-01xx) and addresses.
Safe to re-run: steps 2 and 3 are skipped when offices already exist.
"""

from __future__ import annotations

import json
import math
import os
import random
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import psycopg

from personas import is_terminal, pick

API = os.getenv("API_URL", "http://localhost:4100")
DSN = os.getenv("DATABASE_URL", "postgresql://idx:idx@localhost:5442/idx")
INTERNAL = {"x-internal-token": os.getenv("INTERNAL_TOKEN", "dev-internal-token")}
GEO = Path(os.getenv("GEO_PATH", Path(__file__).resolve().parents[2] / "data" / "geo" / "markets.json"))
LIVE_LEADS = int(os.getenv("SEED_LIVE_LEADS", "120"))
CONTACTS_PER_OFFICE = int(os.getenv("SEED_CONTACTS_PER_OFFICE", "200"))
AGENTS_PER_OFFICE = int(os.getenv("SEED_AGENTS_PER_OFFICE", "25"))
SIM_TIMEOUT = int(os.getenv("SEED_SIM_TIMEOUT", "300"))

# Left unused so a demo can text from them without colliding with seeded contacts.
RESERVED = {"+12025550199", "+12025550198", "+12025550197"}
AREA_CODES = [
    202, 203, 205, 206, 207, 208, 209, 210, 212, 213, 214, 215, 216, 217, 218, 219, 224, 225, 228, 229,
    231, 234, 239, 240, 248, 251, 252, 253, 254, 256, 260, 262, 267, 269, 270, 272, 276, 281, 283, 289,
]
BRAND = ["#0f766e", "#1d4ed8", "#7c3aed", "#b45309", "#be123c", "#047857", "#4338ca", "#a21caf",
         "#0e7490", "#c2410c", "#15803d", "#334155"]
FIRST = ["Avery", "Blair", "Cora", "Dmitri", "Elena", "Felix", "Greta", "Hugo", "Iris", "Jasper", "Kaya", "Leon",
         "Mira", "Nico", "Opal", "Pavel", "Quinn", "Rhea", "Soren", "Tess", "Uma", "Vance", "Wren", "Xavi", "Yara",
         "Zane", "Ada", "Bram", "Celia", "Dario", "Esme", "Finn", "Gemma", "Hollis", "Ines", "Joaquin", "Kit", "Lark",
         "Milo", "Nell", "Otto", "Pia", "Rafe", "Sage", "Theo", "Vera", "Wyatt", "Zora"]
LAST = ["Abernethy", "Blackwood", "Calloway", "Delacroix", "Ellsworth", "Fairfax", "Grimsby", "Holloway", "Ivers",
        "Jurado", "Kettering", "Lindqvist", "Marchetti", "Nakashima", "Okonkwo", "Pellegrino", "Quillen", "Rasmussen",
        "Sorensen", "Tremaine", "Ulloa", "Vanterpool", "Wexford", "Yarborough", "Zeller", "Ashcombe", "Brightman",
        "Castellan", "Dunmore", "Everly", "Fenwick", "Galbraith", "Hargrove", "Iverson", "Kilbride", "Lowther"]

rng = random.Random(20261016)
NOW = datetime.now(UTC)


def log(msg: str) -> None:
    print(f"[seed] {msg}", flush=True)


class Phones:
    def __init__(self, taken: set[str]):
        self.taken = set(taken) | RESERVED
        self.pool = (f"+1{a}55501{n:02d}" for a in AREA_CODES for n in range(100))

    def next(self) -> str:
        for p in self.pool:
            if p not in self.taken:
                self.taken.add(p)
                return p
        raise RuntimeError("fictional number pool exhausted")


def point_in(ring: list[list[float]], x: float, y: float) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def sample_in(ring: list[list[float]]) -> tuple[float, float]:
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    while True:
        x, y = rng.uniform(min(xs), max(xs)), rng.uniform(min(ys), max(ys))
        if point_in(ring, x, y):
            return x, y


def scaled(ring: list[list[float]], centroid: list[float], k: float) -> list[list[float]]:
    cx, cy = centroid
    return [[round(cx + (x - cx) * k, 6), round(cy + (y - cy) * k, 6)] for x, y in ring]


def wkt(ring: list[list[float]]) -> str:
    return "POLYGON((" + ",".join(f"{x} {y}" for x, y in ring) + "))"


def wait_ready(client: httpx.Client, conn: psycopg.Connection) -> None:
    deadline = time.time() + 900
    while time.time() < deadline:
        try:
            if client.get(f"{API}/healthz").status_code == 200:
                break
        except httpx.HTTPError:
            pass
        time.sleep(3)
    log("api is up; waiting for the replication backfill and the indexer")
    while time.time() < deadline:
        row = conn.execute(
            """SELECT bool_and(backfill_complete), (SELECT count(*) FROM listings),
                      (SELECT count(*) FROM outbox WHERE published_at IS NULL)
               FROM replication_state"""
        ).fetchone()
        done, listings, backlog = row
        if done and listings > 0 and backlog < 200:
            log(f"backfill complete: {listings} listings replicated, outbox backlog {backlog}")
            return
        time.sleep(5)
    raise SystemExit("timed out waiting for replication")


def wait_indexed(client: httpx.Client, slug: str) -> None:
    for _ in range(120):
        r = client.post(f"{API}/v1/t/{slug}/search", json={"size": 1})
        if r.status_code == 200 and r.json()["total"] > 1000:
            return
        time.sleep(5)
    raise SystemExit("search index never filled")


def seed_static(conn: psycopg.Connection, geo: dict) -> list[dict]:
    offices = []
    phones = Phones(set())
    for mi, market in enumerate(geo["markets"]):
        hoods = {h["id"]: h for h in market["neighborhoods"]}
        for oi, office in enumerate(market["offices"]):
            idx = mi * 4 + oi
            tenant_id = conn.execute(
                """INSERT INTO tenants (slug, name, timezone, sms_number, brand_color, office_location)
                   VALUES (%s, %s, %s, %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326)) RETURNING id""",
                (office["slug"], office["name"], market["timezone"], phones.next(), BRAND[idx],
                 office["location"][0], office["location"][1]),
            ).fetchone()[0]
            for code in office["mls"]:
                conn.execute("INSERT INTO tenant_mls (tenant_id, mls_code) VALUES (%s, %s)", (tenant_id, code))

            agents = []
            for _ in range(AGENTS_PER_OFFICE):
                first, last = rng.choice(FIRST), rng.choice(LAST)
                hours = rng.choice([[10, 12, 14, 16], [9, 11, 13, 15], [11, 13, 15, 17]])
                days = rng.choice([[1, 2, 3, 4, 5, 6], [2, 3, 4, 5, 6, 7], [1, 2, 3, 4, 5, 6, 7]])
                agent_id = conn.execute(
                    """INSERT INTO agents (tenant_id, first_name, last_name, phone, email, capacity, showing_hours, work_days)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                    (tenant_id, first, last, phones.next(), f"{first}.{last}.{rng.randint(10, 99)}@example.com".lower(),
                     rng.choice([8, 10, 12, 15, 20]), hours, days),
                ).fetchone()[0]
                agents.append(agent_id)

            home = hoods[office["neighborhood_id"]]
            near = sorted(market["neighborhoods"], key=lambda h: math.dist(h["centroid"], home["centroid"]))[:3]
            farms = []
            for k, h in enumerate(near):
                ring = scaled(h["polygon"], h["centroid"], 0.7)
                agent_id = agents[k * 3]
                farm_id = conn.execute(
                    """INSERT INTO farm_areas (tenant_id, agent_id, name, geom)
                       VALUES (%s, %s, %s, ST_GeomFromText(%s, 4326)) RETURNING id""",
                    (tenant_id, agent_id, h["name"], wkt(ring)),
                ).fetchone()[0]
                farms.append((farm_id, ring, h))

            seed_contacts(conn, tenant_id, market, agents, farms, phones)
            offices.append({"id": tenant_id, "slug": office["slug"], "name": office["name"], "mls": office["mls"],
                            "timezone": market["timezone"]})
            log(f"seeded {office['name']}")
    return offices


SOURCES = [("sphere", 0.30), ("web_inquiry", 0.25), ("saved_search", 0.15), ("open_house", 0.10),
           ("referral", 0.10), ("import", 0.10)]
TEMPERATURE = [("hot", 0.06), ("warm", 0.18), ("cooling", 0.30), ("cold", 0.46)]


def seed_contacts(conn, tenant_id, market, agents, farms, phones: Phones) -> None:
    activity_rows = []
    for _ in range(CONTACTS_PER_OFFICE):
        source = rng.choices([s for s, _ in SOURCES], weights=[w for _, w in SOURCES])[0]
        temp = rng.choices([t for t, _ in TEMPERATURE], weights=[w for _, w in TEMPERATURE])[0]
        first, last = rng.choice(FIRST), rng.choice(LAST)
        created = NOW - timedelta(days=rng.uniform(3, 120))
        home = None
        if source == "sphere" or rng.random() < 0.15:
            _, ring, _ = rng.choice(farms)
            home = sample_in(ring)
        opted_out = rng.random() < 0.03
        consent_sms = (rng.random() < 0.7) and not opted_out
        contact_id = conn.execute(
            """INSERT INTO contacts (tenant_id, assigned_agent_id, first_name, last_name, phone, email, source, stage, timezone,
                 consent_sms, consent_email, consent_at, consent_text, opted_out_at, home_location, created_at, updated_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                 CASE WHEN %s::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint(%s, %s), 4326) END, %s, %s)
               RETURNING id""",
            (tenant_id, rng.choice(agents), first, last, phones.next(), f"{first}.{last}{rng.randint(1, 999)}@example.com".lower(),
             source, "nurture" if temp in ("cooling", "cold") else "engaged", market["timezone"], consent_sms,
             rng.random() < 0.85, created if consent_sms else None, "Imported with recorded consent" if consent_sms else None,
             NOW - timedelta(days=rng.uniform(1, 60)) if opted_out else None,
             home[0] if home else None, home[0] if home else None, home[1] if home else None, created, created),
        ).fetchone()[0]

        horizon = {"hot": 6, "warm": 20, "cooling": 45, "cold": 90}[temp]
        count = {"hot": rng.randint(8, 16), "warm": rng.randint(5, 10), "cooling": rng.randint(3, 8), "cold": rng.randint(1, 5)}[temp]
        kinds = [("listing_view", 0.5), ("favorite", 0.12), ("email_open", 0.2), ("email_click", 0.06), ("sms_in", 0.06),
                 ("sms_out", 0.06)]
        events = []
        if source in ("web_inquiry", "saved_search", "open_house"):
            kind = {"web_inquiry": "inquiry", "saved_search": "saved_search", "open_house": "open_house_visit"}[source]
            events.append((kind, created))
        for _ in range(count):
            age = min((NOW - created).days, rng.uniform(0, horizon))
            events.append((rng.choices([k for k, _ in kinds], weights=[w for _, w in kinds])[0], NOW - timedelta(days=age)))
        for kind, at in events:
            activity_rows.append((tenant_id, contact_id, kind, "{}", at))

        if source == "saved_search" or rng.random() < 0.12:
            hood = rng.choice(market["neighborhoods"])
            beds = rng.choice([2, 3, 3, 4])
            price = int(round(hood["base_ppsf"] * (900 + beds * 450) * rng.uniform(1.0, 1.3), -4))
            filters = {"beds_min": beds, "price_max": price, "statuses": ["Active", "ComingSoon"], "features": [],
                       "keywords": [], "property_types": [], "sort": "newest", "price_min": None, "baths_min": None,
                       "sqft_min": None, "max_days_on_market": None,
                       "location": {"kind": "neighborhood", "id": hood["id"], "name": hood["name"]}}
            name = f"{beds}+ bd under ${price // 1000}K in {hood['name']}"
            conn.execute(
                "INSERT INTO saved_searches (tenant_id, contact_id, name, filters, created_at) VALUES (%s, %s, %s, %s, %s)",
                (tenant_id, contact_id, name, json.dumps(filters), created),
            )
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO contact_activity (tenant_id, contact_id, kind, meta, occurred_at) VALUES (%s, %s, %s, %s, %s)",
            activity_rows,
        )


def run_live_leads(client: httpx.Client, conn: psycopg.Connection, offices: list[dict]) -> dict:
    taken = {r[0] for r in conn.execute("SELECT phone FROM contacts UNION SELECT phone FROM agents UNION SELECT sms_number FROM tenants")}
    phones = Phones(taken)
    personas: dict[str, object] = {}
    office_number = {}
    started = 0
    for i in range(LIVE_LEADS):
        office = offices[i % len(offices)]
        listings = client.post(f"{API}/v1/t/{office['slug']}/search", json={"size": 60, "filters": {"statuses": ["Active"]}}).json()["results"]
        listing = rng.choice(listings)
        phone = phones.next()
        first, last = rng.choice(FIRST), rng.choice(LAST)
        body = {"first_name": first, "last_name": last, "phone": phone, "email": f"{first}.{last}.{i}@example.com".lower(),
                "listing_id": listing["id"], "consent_sms": True, "message": "Is this one still available?"}
        r = client.post(f"{API}/v1/t/{office['slug']}/leads", json=body)
        if r.status_code >= 300:
            log(f"lead failed {r.status_code}: {r.text[:200]}")
            continue
        personas[phone] = pick(rng)
        started += 1
        if i % 3 == 0:
            time.sleep(0.2)
    log(f"submitted {started} live inquiries; buyers are now texting back through the sandbox")
    for row in conn.execute("SELECT t.sms_number, t.slug FROM tenants t"):
        office_number[row[1]] = row[0]

    last_id = 0
    quiet_since = time.time()
    deadline = time.time() + SIM_TIMEOUT
    replies = 0
    while time.time() < deadline:
        rows = conn.execute(
            "SELECT id, handset, brokerage_number, body FROM sandbox_sms WHERE direction = 'to_handset' AND id > %s ORDER BY id",
            (last_id,),
        ).fetchall()
        conn.commit()
        if rows:
            quiet_since = time.time()
        for sms_id, handset, brokerage, text in rows:
            last_id = sms_id
            persona = personas.get(handset)
            if not persona or is_terminal(text) and persona.kind != "stop":
                continue
            answer = persona.respond(text, rng)
            if answer:
                client.post(f"{API}/sandbox/handsets/{handset}/send", json={"to": brokerage, "body": answer})
                replies += 1
        if time.time() - quiet_since > 25:
            break
        time.sleep(0.5)
    kinds: dict[str, int] = {}
    for p in personas.values():
        kinds[p.kind] = kinds.get(p.kind, 0) + 1
    log(f"buyers sent {replies} replies; persona mix {kinds}")
    return kinds


def dev_token(client: httpx.Client, **body) -> dict:
    token = client.post(f"{API}/v1/auth/dev-token", json=body).json()["token"]
    return {"authorization": f"Bearer {token}"}


def finish(client: httpx.Client, conn: psycopg.Connection, offices: list[dict], geo: dict) -> None:
    r = client.post(f"{API}/internal/jobs/saved-searches/reindex", headers=INTERNAL, timeout=300)
    log(f"percolators registered: {r.json()}")
    r = client.post(f"{API}/internal/jobs/score-all", headers=INTERNAL, timeout=300)
    log(f"relationship scores: {r.json()}")
    if conn.execute("SELECT count(*) FROM farm_reports").fetchone()[0] == 0:
        r = client.post(f"{API}/internal/jobs/farm-reports", headers=INTERNAL, timeout=600)
        log(f"farm reports: {r.json()}")
        for office in offices:
            headers = dev_token(client, tenant_slug=office["slug"])
            farms = client.get(f"{API}/v1/console/farms", headers=headers).json()
            first = next((f for f in farms if f["report_status"] == "draft"), None)
            if first:
                client.post(f"{API}/v1/console/reports/{first['report_id']}/send", headers=headers)
    queries = [json.loads(line)["q"] for line in (Path(__file__).parent / "queries.jsonl").read_text().splitlines() if line.strip()]
    for i in range(160):
        office = offices[i % len(offices)]
        client.post(f"{API}/v1/t/{office['slug']}/search", json={"q": rng.choice(queries), "size": 24})
    log("ran 160 natural-language searches")
    platform = dev_token(client, platform=True)
    client.post(f"{API}/v1/ops/search-quality/run", headers=platform, timeout=120)


def main() -> None:
    geo = json.loads(GEO.read_text(encoding="utf-8"))
    with httpx.Client(timeout=30) as client, psycopg.connect(DSN, autocommit=False) as conn:
        wait_ready(client, conn)
        existing = conn.execute("SELECT count(*) FROM tenants").fetchone()[0]
        if existing:
            log(f"{existing} offices already exist; skipping static seed and live leads")
            offices = [{"id": r[0], "slug": r[1]} for r in conn.execute("SELECT id, slug FROM tenants ORDER BY slug")]
        else:
            offices = seed_static(conn, geo)
            conn.commit()
            log("static data committed")
            wait_indexed(client, offices[0]["slug"])
            run_live_leads(client, conn, offices)
        finish(client, conn, offices, geo)
        conn.commit()
        summary = conn.execute(
            """SELECT (SELECT count(*) FROM tenants), (SELECT count(*) FROM agents), (SELECT count(*) FROM contacts),
                      (SELECT count(*) FROM conversations WHERE first_inquiry_at IS NOT NULL),
                      (SELECT count(*) FROM messages), (SELECT count(*) FROM appointments),
                      (SELECT count(*) FROM relationship_scores), (SELECT count(*) FROM farm_reports)"""
        ).fetchone()
        log("done: offices={} agents={} contacts={} live_conversations={} messages={} appointments={} scores={} farm_reports={}".format(*summary))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(1)
