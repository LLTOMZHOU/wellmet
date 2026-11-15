# Capacity model: agent-first scheduler, at the 24-month load in frame.md (L2), all figures assumed (request volume x10)

All figures are calculated from the assumptions file, not measured.

## Load

| Workload | Requests/day | Avg rps | Peak rps | In flight at peak | Instances |
|---|---|---|---|---|---|
| booking page view (F4, L2) | 5,000 | 0.06 | 1.16 | n/a | n/a |
| slot lookup, web and agent (T2, L2) | 10,000 | 0.12 | 2.31 | n/a | n/a |
| booking request (F4, F5, L2) | 200 | 0.0023 | 0.05 | n/a | n/a |
| guest cancel or reschedule (F8) | 50.0 | 0.00058 | 0.0058 | n/a | n/a |
| owner MCP call (F2, F3, L2) | 2,000 | 0.02 | 0.23 | n/a | n/a |
| public agent call (F5, L2) | 5,000 | 0.06 | 1.16 | n/a | n/a |
| abusive flood, refused (S4) | 100,000 | 1.16 | 57.9 | n/a | n/a |

Instances are sized for 60% utilization at peak, one pool per workload. "(minimum)" marks a count set by the floor of 2, not by load. No spare is included for losing a zone or a node.

## Network and storage

| Workload | Ingress at peak | Egress at peak | Egress/month | Stored/day |
|---|---|---|---|---|
| booking page view (F4, L2) | 9.3 kbps | 277.8 kbps | 4.5 GB | n/a |
| slot lookup, web and agent (T2, L2) | 9.3 kbps | 92.6 kbps | 1.5 GB | n/a |
| booking request (F4, F5, L2) | 741 bps | 741 bps | 12.0 MB | 600.0 KB |
| guest cancel or reschedule (F8) | 46 bps | 93 bps | 3.0 MB | 50.0 KB |
| owner MCP call (F2, F3, L2) | 3.7 kbps | 9.3 kbps | 300.0 MB | 1.0 MB |
| public agent call (F5, L2) | 9.3 kbps | 37.0 kbps | 600.0 MB | 1.0 MB |
| abusive flood, refused (S4) | 231.5 kbps | 231.5 kbps | 1.5 GB | n/a |

Total stored after 1825 days at replication factor 1: 4.8 GB.

## Not computed

- booking page view (F4, L2): instances (needs service_ms and concurrency_per_instance)
- slot lookup, web and agent (T2, L2): instances (needs service_ms and concurrency_per_instance)
- booking request (F4, F5, L2): instances (needs service_ms and concurrency_per_instance)
- guest cancel or reschedule (F8): instances (needs service_ms and concurrency_per_instance)
- owner MCP call (F2, F3, L2): instances (needs service_ms and concurrency_per_instance)
- public agent call (F5, L2): instances (needs service_ms and concurrency_per_instance)
- abusive flood, refused (S4): instances (needs service_ms and concurrency_per_instance)

