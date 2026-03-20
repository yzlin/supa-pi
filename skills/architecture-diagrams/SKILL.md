---
name: architecture-diagrams
description: Create architecture diagrams (C4, sequence, data flow, etc.) in Mermaid syntax for architectural assessments and system design tasks.
---

# Architecture Diagrams

## Trigger Conditions
- Architectural assessment requested
- New system design task
- C4 diagrams needed
- "diagram", "architecture", "system design" mentioned

## Required Diagrams

For every architectural assessment, create the following diagrams using Mermaid syntax:

### 1. System Context Diagram

- Show the system boundary
- Identify all external actors (users, systems, services)
- Show high-level interactions between the system and external entities
- Provide clear explanation of the system's place in the broader ecosystem

### 2. Component Diagram

- Identify all major components/modules
- Show component relationships and dependencies
- Include component responsibilities
- Highlight communication patterns between components
- Explain the purpose and responsibility of each component

### 3. Deployment Diagram

- Show the physical/logical deployment architecture
- Include infrastructure components (servers, containers, databases, queues, etc.)
- Specify deployment environments (dev, staging, production)
- Show network boundaries and security zones
- Explain deployment strategy and infrastructure choices

### 4. Data Flow Diagram

- Illustrate how data moves through the system
- Show data stores and data transformations
- Identify data sources and sinks
- Include data validation and processing points
- Explain data handling, transformation, and storage strategies

### 5. Sequence Diagram

- Show key user journeys or system workflows
- Illustrate interaction sequences between components
- Include timing and ordering of operations
- Show request/response flows
- Explain the flow of operations for critical use cases

### 6. Other Relevant Diagrams (as needed)

Based on the specific requirements, include additional diagrams such as:

- Entity Relationship Diagrams (ERD) for data models
- State diagrams for complex stateful components
- Network diagrams for complex networking requirements
- Security architecture diagrams
- Integration architecture diagrams
