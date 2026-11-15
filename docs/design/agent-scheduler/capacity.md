# Capacity model: agent-first scheduler, at the 24-month load in frame.md (L2), all figures assumed

All figures are calculated from the assumptions file, not measured.

## Load

| Workload | Requests/day | Avg rps | Peak rps | In flight at peak | Instances |
|---|---|---|---|---|---|
| booking page view (F4, L2) | 500 | 0.0058 | 0.12 | n/a | n/a |
| slot lookup, web and agent (T2, L2) | 1,000 | 0.01 | 0.23 | n/a | n/a |
| booking request (F4, F5, L2) | 20.0 | 0.00023 | 0.0046 | n/a | n/a |
| guest cancel or reschedule (F8) | 5.00 | 5.8e-05 | 0.00058 | n/a | n/a |
| owner MCP call (F2, F3, L2) | 200 | 0.0023 | 0.02 | n/a | n/a |
| public agent call (F5, L2) | 500 | 0.0058 | 0.12 | n/a | n/a |
| abusive flood, refused (S4) | 10,000 | 0.12 | 5.79 | n/a | n/a |

Instances are sized for 60% utilization at peak, one pool per workload. "(minimum)" marks a count set by the floor of 2, not by load. No spare is included for losing a zone or a node.

## Network and storage

| Workload | Ingress at peak | Egress at peak | Egress/month | Stored/day |
|---|---|---|---|---|
| booking page view (F4, L2) | 926 bps | 27.8 kbps | 450.0 MB | n/a |
| slot lookup, web and agent (T2, L2) | 926 bps | 9.3 kbps | 150.0 MB | n/a |
| booking request (F4, F5, L2) | 74 bps | 74 bps | 1.2 MB | 60.0 KB |
| guest cancel or reschedule (F8) | 5 bps | 9 bps | 300.0 KB | 5.0 KB |
| owner MCP call (F2, F3, L2) | 370 bps | 926 bps | 30.0 MB | 100.0 KB |
| public agent call (F5, L2) | 926 bps | 3.7 kbps | 60.0 MB | 100.0 KB |
| abusive flood, refused (S4) | 23.1 kbps | 23.1 kbps | 150.0 MB | n/a |

Total stored after 1825 days at replication factor 1: 483.6 MB.

## Not computed

- booking page view (F4, L2): instances (needs service_ms and concurrency_per_instance)
- slot lookup, web and agent (T2, L2): instances (needs service_ms and concurrency_per_instance)
- booking request (F4, F5, L2): instances (needs service_ms and concurrency_per_instance)
- guest cancel or reschedule (F8): instances (needs service_ms and concurrency_per_instance)
- owner MCP call (F2, F3, L2): instances (needs service_ms and concurrency_per_instance)
- public agent call (F5, L2): instances (needs service_ms and concurrency_per_instance)
- abusive flood, refused (S4): instances (needs service_ms and concurrency_per_instance)

