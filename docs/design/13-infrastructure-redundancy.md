# 13 — Infrastructure Redundancy

S3 (MinIO) and Gitea are single points of failure. This spec defines how to replicate both across multiple ships so the fleet survives a machine going down.

## Ships as Virtual Machines

A ship is a virtual machine, not a physical machine. A single physical machine can host multiple ships. This decouples the fleet from hardware — ships can be created, destroyed, moved, and cloned without touching physical infrastructure.

### Model

```
Physical Machine (host)
  +-- VM "HERACLES" (ship)
  |     +-- helm (relay)
  |     +-- cid (engineer)
  |     +-- parker (engineer)
  +-- VM "OLYMPUS" (ship)
        +-- helm (relay)
        +-- albert (architect)
        +-- nora (navigator)
```

### Why VMs

- **Isolation:** Ships are fully isolated from each other. A runaway bot on one ship cannot affect another ship on the same hardware.
- **Portability:** A ship can be migrated between physical machines (live migration, snapshot/restore, or cold move) without any config changes.
- **Density:** Small ships (1-2 bots) can share hardware. Dedicated hardware is reserved for heavy workloads.
- **Reproducibility:** Ship VMs can be provisioned from a base image. Spinning up a new ship is `create VM + bootstrap` rather than configuring bare metal.
- **Holodeck:** Holodeck simulation ships (see `12-deployment-chain.md`) are natural fits for ephemeral VMs — create for the test, destroy after.

### Fleet Registry

`machines.json` gains a `host` field to track physical placement:

```json
{
  "HERACLES": { "host": "mac-studio", "os": "macOS", "user": "ww5", "active": true, "rank": 2 },
  "OLYMPUS": { "host": "mac-studio", "os": "macOS", "user": "ww5", "active": true, "rank": 3 }
}
```

Multiple ships can share the same `host`. The fleet treats each ship as independent regardless of physical placement.

### VM Technology

No strong opinion on hypervisor — use whatever is native to the host OS:
- **macOS:** Virtualization.framework (via UTM or Tart), or Lima for lightweight Linux VMs
- **Linux:** KVM/QEMU (via libvirt), or Incus/LXD for container-based VMs

The ship doesn't need to know it's in a VM. From the ship's perspective, it's a machine with a user account, git repos, and podman.

## Gitea Redundancy

Git is already distributed — every ship that clones a repo has a full copy. The question is who serves the origin.

### Strategy: Multi-Remote Push (Active-Active)

Every ship pushes to two Gitea instances simultaneously using git's built-in multi-remote support:

```bash
git remote set-url --add --push origin https://gitea1.local/repo.git
git remote set-url --add --push origin https://gitea2.local/repo.git
```

Every push hits both. Every pull can use either. If one Gitea goes down, the other keeps serving with zero intervention.

### Setup

1. Run a second Gitea instance on the second-ranked machine
2. Mirror all repos from primary to secondary (initial sync)
3. Configure multi-remote push on every ship
4. The relay's auto-sync already pulls constantly — it can try either origin on failure

### Failover

If the primary Gitea is unreachable:
- Pushes still succeed to the secondary
- Pulls automatically fall back (git tries each URL)
- When primary recovers, next push from any ship brings it current

No manual intervention needed for routine failures.

## S3 (MinIO) Redundancy

### Strategy: Site Replication

MinIO has built-in bidirectional site replication. Two MinIO instances stay in sync automatically:

```bash
mc admin replicate add minio1 minio2
```

Both accept reads and writes. If one goes down, the other keeps serving. When it comes back, they reconcile automatically.

### Setup

1. Run a second MinIO instance on another ship
2. Configure site replication between the two instances
3. Update `fleet.json` with both endpoints

### Failover

If the primary MinIO is unreachable:
- Reads and writes go to the secondary
- When primary recovers, site replication reconciles automatically
- No data loss unless both go down simultaneously

## Fleet Configuration

Add redundancy endpoints to `fleet.json`:

```json
{
  "s3": {
    "endpoints": ["https://s3-primary.local", "https://s3-secondary.local"],
    "bucket": "...",
    "accessKey": "...",
    "secretKey": "..."
  },
  "git": {
    "origins": ["https://gitea1.local", "https://gitea2.local"]
  }
}
```

The relay and bot code should try endpoint[0] first, fall back to endpoint[1] on failure. A simple try/catch wrapper around S3 and git operations is sufficient.

## Why

Currently, if the machine hosting Gitea or MinIO goes down, the entire fleet loses access to code repos and shared state. Both git and MinIO are designed for replication — we just need a second instance of each on a different machine, with their native replication keeping them in sync. No external HA tooling required.
