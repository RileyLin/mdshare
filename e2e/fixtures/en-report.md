# Q3 platform review

## TL;DR
Latency is down 38% and the migration finished a week early. The open risk is on-call load during the holiday freeze.

## Results

Overall the quarter went well. Three things stand out:

- Median latency dropped from 210 ms to 130 ms.
- Error budget burn stayed under 40%.
- Two services were retired.

### Latency by region

| Region | Before (ms) | After (ms) | Change |
|---|---|---|---|
| us-east-1 | 210 | 130 | -38% |
| eu-west-1 | 240 | 150 | -37% |
| ap-south-1 | 320 | 260 | -19% |

## Migration

1. Snapshot the database.
2. Replay writes for **48 hours**.
3. Flip reads, then writes.

Task list:

- [x] Snapshot
- [x] Replay
- [ ] Decommission old cluster

```python
def flip(reads=True, writes=False):
    return {"reads": reads, "writes": writes}
```

## Risks

> Warning: holiday freeze starts Dec 20 and two of five on-call engineers are out.

Nested detail:

- Staffing
  - Backfill one engineer
  - Move one rotation
- Tooling

Some *emphasis*, some **bold**, `inline code`, and a [link](https://example.com/docs).

![chart](data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='40'%3E%3Crect width='120' height='40' fill='%23b4532a'/%3E%3C/svg%3E)

## Next steps

Finish the decommission and write the postmortem.
