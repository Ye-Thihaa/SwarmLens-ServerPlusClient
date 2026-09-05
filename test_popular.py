"""Popular-spot test: proves `guests` is a distinct-guest set union, not a
frame count, and that it merges across a partition the way likes do.

The failures this is written against are the ones that look correct until
more than one person is in the room:

  - Counting frames instead of people. One guest firing off ten shots at the
    coat rack would outrank a genuine crowd at the arch, which is the exact
    claim "popular spot" is making and the exact claim that would be false.
  - Storing the count as a number and incrementing it. Two nodes that each
    saw a different guest during a partition hold 1 and 1, and merging those
    cannot recover 2 without double-counting every gossip re-delivery. The
    set union recovers it and is idempotent under re-delivery.
  - /zones and /zones/quorum computing the score in two places that drift.
    They are separate derivations over different inputs (this node's DB vs a
    merged event set), so they are asserted to agree.
  - A retracted photo still counting its guest toward the crowd.

Self-contained: starts/kills its own processes, cleans up its own .db files.
"""
import os
import subprocess
import sys
import time

import httpx

from testutil import ensure_safe_to_run

NODES = [
    ("node1", 8001, "http://127.0.0.1:8002,http://127.0.0.1:8003"),
    ("node2", 8002, "http://127.0.0.1:8001,http://127.0.0.1:8003"),
    ("node3", 8003, "http://127.0.0.1:8001,http://127.0.0.1:8002"),
]

# guests*3 + likes*2 + frames, where each guest contributes at most 3 frames.
# Mirrored from main.py rather than imported, on purpose: importing the
# weights would make the test agree with a typo in them.
FRAMES_PER_GUEST = 3


def expected(likes, frames_by_guest):
    """frames_by_guest: the per-guest frame counts for one zone."""
    return (
        len(frames_by_guest) * 3
        + likes * 2
        + sum(min(n, FRAMES_PER_GUEST) for n in frames_by_guest)
    )


procs = {}


def start_all():
    for node_id, port, peers in NODES:
        env = os.environ.copy()
        env["NODE_ID"] = node_id
        env["DB_PATH"] = f"./{node_id}.db"
        env["SELF_URL"] = f"http://127.0.0.1:{port}"
        env["PEERS"] = peers
        env["GOSSIP_INTERVAL"] = "1.0"
        p = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "main:app", "--port", str(port)],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        procs[node_id] = (p, port)
    print("started:", {k: v[1] for k, v in procs.items()})


# trust_env=False throughout: every call targets 127.0.0.1, and a system
# HTTP proxy would otherwise intercept loopback traffic (see CLAUDE.md).
def get(port, path, **params):
    return httpx.get(f"http://127.0.0.1:{port}{path}", params=params or None,
                     timeout=5.0, trust_env=False)


def post(port, path, body=None):
    return httpx.post(f"http://127.0.0.1:{port}{path}", json=body,
                      timeout=5.0, trust_env=False)


def wait_up(timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if all(get(port, "/health").status_code == 200 for _, port, _ in NODES):
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def shoot(port, zone, guest, event_id=None):
    body = {"guest_id": guest, "zone": zone, "composition_score": 80}
    if event_id:
        body["event_id"] = event_id
    r = post(port, "/photos", body)
    r.raise_for_status()
    return r.json()["photo_id"]


def zones(port, event_id=None):
    r = get(port, "/zones", **({"event_id": event_id} if event_id else {}))
    r.raise_for_status()
    return {z["zone"]: z for z in r.json()["zones"]}


def zones_quorum(port, R, event_id=None):
    params = {"R": R}
    if event_id:
        params["event_id"] = event_id
    r = get(port, "/zones/quorum", **params)
    r.raise_for_status()
    return {z["zone"]: z for z in r.json()["zones"]}


ok, failed = [], []


def check(name, cond, detail=""):
    (ok if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  -- {detail}" if detail else ""))


def stop_all():
    for p, _ in procs.values():
        p.terminate()
    for p, _ in procs.values():
        try:
            p.wait(timeout=5)
        except Exception:
            p.kill()


def main():
    ensure_safe_to_run()
    start_all()
    if not wait_up():
        print("FAIL: nodes never came up")
        return 1

    ev = post(8001, "/events", {
        "slug": "popular-test", "name": "Popular Test", "venue": "lab",
        "zones": ["arch", "coat rack", "bar"],
    })
    ev.raise_for_status()
    event_id = ev.json()["event_id"]
    time.sleep(3)  # let the event_created row gossip out

    print("\n[1] a crowd beats one enthusiast")
    # arch: 3 different people, 1 frame each. coat rack: 1 person, 10 frames.
    for g in ("alice", "bob", "carol"):
        shoot(8001, "arch", g, event_id)
    for _ in range(10):
        shoot(8001, "coat rack", "dave", event_id)
    time.sleep(3)

    z = zones(8001, event_id)
    arch, coat = z["arch"], z["coat rack"]
    check("arch counts 3 people, not 3 frames", arch["guests"] == 3,
          f"guests={arch['guests']} photos={arch['photos']}")
    check("coat rack counts 1 person despite 10 frames",
          coat["guests"] == 1 and coat["photos"] == 10,
          f"guests={coat['guests']} photos={coat['photos']}")
    check("a crowd of 3 outranks one enthusiast with 10 frames",
          arch["popular_score"] > coat["popular_score"],
          f"arch={arch['popular_score']} coat={coat['popular_score']}")
    check("score matches the published formula",
          arch["popular_score"] == expected(arch["likes"], [1, 1, 1]),
          f"got {arch['popular_score']}, expected {expected(arch['likes'], [1, 1, 1])}")
    check("one guest's burst is capped, not counted ten times",
          coat["popular_score"] == expected(coat["likes"], [10]),
          f"got {coat['popular_score']}, expected {expected(coat['likes'], [10])}")
    check("the popular spot ranks first",
          list(zones(8001, event_id))[0] == "arch",
          f"order: {list(zones(8001, event_id))}")

    print("\n[2] every node agrees, and so does the quorum path")
    per_node = {}
    for _, port, _ in NODES:
        per_node[port] = zones(port, event_id)["arch"]["popular_score"]
    check("all 3 nodes report the same score", len(set(per_node.values())) == 1, f"{per_node}")
    q = zones_quorum(8001, 3, event_id)["arch"]
    check("/zones/quorum agrees with /zones",
          q["popular_score"] == arch["popular_score"] and q["guests"] == arch["guests"],
          f"quorum={q['popular_score']}/{q['guests']} local={arch['popular_score']}/{arch['guests']}")

    print("\n[3] a partition splits the crowd, healing merges it")
    # isolate node3 in both directions -- 4 calls, see CLAUDE.md
    post(8001, "/chaos/partition/1")
    post(8002, "/chaos/partition/1")
    post(8003, "/chaos/partition/0")
    post(8003, "/chaos/partition/1")
    time.sleep(1)

    shoot(8001, "bar", "erin", event_id)   # only node1+node2 will see this
    shoot(8003, "bar", "frank", event_id)  # only node3 will see this
    time.sleep(3)

    split_1 = zones(8001, event_id)["bar"]
    split_3 = zones(8003, event_id)["bar"]
    check("each side sees only its own guest",
          split_1["guests"] == 1 and split_3["guests"] == 1,
          f"node1={split_1['guests']} node3={split_3['guests']}")

    for _, port, _ in NODES:
        post(port, "/chaos/heal")

    merged = None
    for _ in range(20):
        time.sleep(1)
        a = zones(8001, event_id)["bar"]
        b = zones(8003, event_id)["bar"]
        if a["guests"] == b["guests"] == 2:
            merged = a
            break
    check("healing unions both guests, none lost", merged is not None,
          f"node1={zones(8001, event_id)['bar']['guests']} "
          f"node3={zones(8003, event_id)['bar']['guests']}")
    if merged:
        check("merged score follows the formula",
              merged["popular_score"] == expected(merged["likes"], [1, 1]),
              f"got {merged['popular_score']}")

    print("\n[4] re-delivery is idempotent, deletion retracts the guest")
    before = zones(8001, event_id)["arch"]["guests"]
    time.sleep(2.5)  # more gossip rounds over events every node already has
    check("extra gossip rounds don't inflate the count",
          zones(8001, event_id)["arch"]["guests"] == before, f"{before} -> stable")

    solo = shoot(8002, "bar", "grace", event_id)
    time.sleep(3)
    with_grace = zones(8001, event_id)["bar"]["guests"]
    post(8002, "/photos/delete", {"guest_id": "grace", "photo_id": solo, "vclock": {}})
    time.sleep(3)
    after = zones(8001, event_id)["bar"]["guests"]
    check("a guest whose only frame was deleted stops counting",
          with_grace == 3 and after == 2, f"{with_grace} -> {after}")

    print(f"\n===== {len(ok)} passed, {len(failed)} failed =====")
    if failed:
        print("FAILED: " + "; ".join(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    code = 1
    try:
        code = main()
    finally:
        stop_all()
        time.sleep(0.5)
        for node_id, _, _ in NODES:
            try:
                os.remove(f"./{node_id}.db")
            except FileNotFoundError:
                pass
    sys.exit(code)
