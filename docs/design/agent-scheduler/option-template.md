# Option <letter>: <name>

**Premise:** <what this optimizes for>

## Summary
One paragraph a new engineer could repeat back.

## Components
Each component, what it is responsible for, and what it is built from.

## Diagram
A Mermaid flowchart. Draw every trust boundary as a subgraph and label
each arrow that crosses one.

## Critical path
Walk the most important request hop by hop, with a p99 budget per hop
that fits the frame's target.

## Data
What is stored where, the consistency each read gets, and how data moves
between stores.

## Scaling
The first bottleneck, the load at which it bites, and what is done then.

## Failure behaviour
For each component and external dependency: what users see when it is
down, and when it is slow.

## Security
Trust boundaries, how each caller is authenticated and authorized at each
hop, where secrets and sensitive data live, how tenants are isolated.

## Cost
Monthly cost at target load and at 10x, itemized.

## Operations
What is deployed, how it is rolled back, what is monitored, what pages
someone.

## Build and rollout
Rough effort for the team in the frame, the order things are built in,
and how to move from what exists today without a big-bang cutover.

## Scenario scorecard
| Scenario or constraint id | Pass / fail / unknown | Number | Basis |
One row per scenario and per hard constraint in the frame.

## Worst at
What this design is worst at compared with a balanced one.

## Riskiest assumption
The single assumption that, if wrong, sinks this option, and how to test it.

## Hard to reverse
Choices in this option that would be expensive to undo.
