**FACTS Module Design Guide**

AI Instruction for Generating FACTS Modules

with Workflow Diagrams

Federated Abstraction for Canvas Tooling & Schema

Version 1.0.0

# 1. Overview

This document provides step-by-step instructions for an AI to guide
users through designing a FACTS module definition and generating an
accompanying SVG workflow diagram. The AI should act as a business
process consultant: asking the right questions, designing an appropriate
workflow, producing a schema-compliant JSON module, and visualizing the
workflow as a flowchart.

## 1.1 What is FACTS?

FACTS (**F**orm,**A**ctivity,**C**ontrolled **T**ransition,**S**tate) is
a human-readable, name-based contract for defining business modules. It
abstracts away internal IDs, GUIDs, and numeric enums. All identifiers
use display names, and the MCP layer resolves them automatically.

A FACTS module consists of these core components:

-   **information** --- Field definitions (the data captured per entry)

-   **states** --- Workflow states with color-coded badges

-   **activities** --- Custom actions that users or AI agents can
    perform

-   **flows** --- State transition rules linking activities to state
    changes

-   **listings** --- Named views with pre-configured filters and columns

-   **documents** --- Document templates with auto-numbering prefixes

## 1.2 Interaction Flow

Follow this sequence when a user requests a new module:

1.  **Gather requirements** --- Ask clarifying questions to understand
    the business process, issue types, typical workflow, and tracking
    priorities.

2.  **Design the workflow** --- Identify states, activities,
    transitions, and side branches (escalation, external blocks,
    cancellations).

3.  **Generate the workflow diagram** --- Produce an SVG flowchart using
    the exact state colors from the schema.

4.  **Generate the FACTS JSON** --- Produce a complete, schema-compliant
    module definition file.

5.  **Explain and iterate** --- Walk the user through the design and
    refine based on feedback.

# 2. Gathering Requirements

Before designing anything, ask the user 2--3 targeted questions to
understand their process. Present these as selectable choices when
possible. Recommended questions:

## 2.1 Issue/Item Types

Ask what categories of items the module will track. Use multi-select so
the user can pick several. Example for a service company:

-   Installation issues

-   Maintenance/servicing

-   Repair/breakdown

-   Warranty claims

## 2.2 Typical Workflow

Ask how work typically flows from start to finish. Offer common patterns
as single-select options:

-   Customer reports → Technician assigned → On-site visit → Resolution

-   Customer reports → Diagnosis → Quote approval → Repair → Invoice

-   Customer reports → Triage → Schedule → Dispatch → Complete

-   Other (user describes their own)

## 2.3 Tracking Priorities

Ask what matters most to track. Use rank-priorities so the user can
order them. Example:

-   Technician assignment & scheduling

-   Parts/cost tracking

-   SLA & response time

-   Customer communication history

# 3. State Color System

Every state must use one of exactly 8 hex colors from the FACTS palette.
These colors are designed for white text on a colored background (WCAG
AA 4.5:1+ contrast). Never invent custom hex values.

## 3.1 Color Palette

  ------------- ------------- ------------------------------------------------
  **Color**     **Label**     **When to Use**

  **#5A6070**   **Grey**      Not started, idle, queued, no action expected

  **#2968A8**   **Blue**      Waiting for an actor to take next action, no
                              urgency

  **#2A7B50**   **Green**     Work is actively being executed by an actor
                              right now

  **#A07828**   **Amber**     Deadline approaching, condition flagged, action
                              needed soon

  **#C0392B**   **Red**       SLA breached, escalation required, process stuck

  **#6B4D91**   **Purple**    Blocked by external dependency outside this
                              workflow

  **#1E6B45**   **Dark        Terminal success (approved, completed, closed)
                green**       

  **#8B2D2D**   **Dark red**  Terminal failure (rejected, cancelled, failed)
  ------------- ------------- ------------------------------------------------

## 3.2 Color Assignment Rules

Apply these rules in order (stop at the first match):

1.  **Terminal success** → #1E6B45 (dark green)

2.  **Terminal failure/rejection/cancellation** → #8B2D2D (dark red)

3.  **Active work being executed** → #2A7B50 (green)

4.  **SLA breached or escalation required** → #C0392B (red)

5.  **Deadline approaching or flagged** → #A07828 (amber)

6.  **Blocked by external dependency** → #6B4D91 (purple)

7.  **Waiting for next action, no urgency** → #2968A8 (blue)

8.  **Not started, queued, idle** → #5A6070 (grey)

## 3.3 Common Mistakes to Avoid

-   Never use green (#2A7B50) for \"Approved\" --- approval is a
    decision, not active work. Use blue (#2968A8) if awaiting next step,
    or dark green (#1E6B45) if terminal.

-   Never use grey (#5A6070) for \"Closed\" or \"Cancelled\" --- these
    are terminal states.

-   Never use red (#C0392B) for \"Rejected\" --- rejection is a terminal
    outcome, not an escalation. Use dark red (#8B2D2D).

-   Never use green (#2A7B50) for \"Pending\" or \"Waiting\" --- no one
    is actively working.

-   Only one state in a linear workflow should typically be green ---
    the active work state.

-   When unsure, default to blue (#2968A8) --- it is the safest
    general-purpose color.

# 4. Workflow Diagram Specification

Generate an SVG flowchart that visualizes the state transitions. The
diagram must use the exact hex colors from the FACTS state color system
with white text on colored backgrounds.

## 4.1 SVG Structure

Use this SVG setup:

> \<svg width=\"100%\" viewBox=\"0 0 680 H\"\>

Where H is the computed height based on content. Safe drawing area is
x=20 to x=660, y=40 to y=(H-40).

## 4.2 Arrow Marker

Always include this arrow marker in \<defs\> at the start of every SVG:

> \<defs\>
>
> \<marker id=\"arrow\" viewBox=\"0 0 10 10\" refX=\"8\" refY=\"5\"
>
> markerWidth=\"6\" markerHeight=\"6\" orient=\"auto-start-reverse\"\>
>
> \<path d=\"M2 1L8 5L2 9\" fill=\"none\" stroke=\"context-stroke\"
>
> stroke-width=\"1.5\" stroke-linecap=\"round\"
> stroke-linejoin=\"round\"/\>
>
> \</marker\>
>
> \</defs\>

## 4.3 State Box Rendering

Each state is a rounded rectangle filled with the exact hex color from
the schema, with white text:

> \<g class=\"node\" onclick=\"sendPrompt(\'\...\')\"\>
>
> \<rect x=\"X\" y=\"Y\" width=\"W\" height=\"56\" rx=\"8\"
>
> fill=\"#HEX_COLOR\" stroke=\"#DARKER_SHADE\" stroke-width=\"0.5\"/\>
>
> \<text x=\"CX\" y=\"TY1\" text-anchor=\"middle\"
>
> dominant-baseline=\"central\" fill=\"#FFFFFF\"
>
> font-size=\"14\" font-weight=\"500\"
>
> font-family=\"var(\--font-sans)\"\>State Name\</text\>
>
> \<text x=\"CX\" y=\"TY2\" text-anchor=\"middle\"
>
> dominant-baseline=\"central\" fill=\"#FFFFFF\"
>
> font-size=\"12\" opacity=\"0.8\"
>
> font-family=\"var(\--font-sans)\"\>Subtitle\</text\>
>
> \</g\>

Key rules for state boxes:

-   **fill** = exact hex from the FACTS state color palette

-   **stroke** = a slightly darker shade of the same color

-   **All text fill=\"#FFFFFF\"** --- white text on colored background

-   **Title**: font-size=\"14\", font-weight=\"500\"

-   **Subtitle**: font-size=\"12\", opacity=\"0.8\"

-   **Height**: 56px for two-line boxes (title + subtitle)

-   **rx=\"8\"** for rounded corners

## 4.4 Layout Rules

### 4.4.1 Main Flow (Vertical)

The primary happy path flows top-to-bottom, centered at x=340. Each
main-flow state box is 180px wide (x=250 to x=430). Leave 54px minimum
vertical gap between boxes for the arrow and activity label.

### 4.4.2 Vertical Arrows with Labels

Vertical arrows connect the main flow states. Place the activity name to
the right of the arrow:

> \<line x1=\"340\" y1=\"96\" x2=\"340\" y2=\"150\"
>
> class=\"arr\" marker-end=\"url(#arrow)\"/\>
>
> \<text class=\"ts\" x=\"348\" y=\"128\"
>
> text-anchor=\"start\"\>Activity Name\</text\>

### 4.4.3 Side Branches (Horizontal)

Side branches (escalation, external blockers, cancellation) extend left
or right from the main flow. This is the most critical layout rule:

> **CRITICAL: Leave at least 100px horizontal gap between the main-flow
> box edge and the side-branch box edge. This gap must be wide enough to
> fit the longest activity label without overlapping either box.**

For bidirectional horizontal connections (e.g., In Progress ↔ Awaiting
Parts), split the arrows into two separate lines at different
y-positions:

-   **Forward arrow (top)**: Draw at y = box_y + 15 (upper portion of
    the box). Place label above the arrow.

-   **Return arrow (bottom, dashed)**: Draw at y = box_y + 41 (lower
    portion). Place label below the arrow.

Example for a bidirectional horizontal connection:

> \<!\-- Forward: In Progress → Awaiting Parts \--\>
>
> \<line x1=\"250\" y1=\"385\" x2=\"140\" y2=\"385\"
>
> class=\"arr\" marker-end=\"url(#arrow)\"/\>
>
> \<text class=\"ts\" x=\"195\" y=\"377\"
>
> text-anchor=\"middle\"\>Request parts\</text\>
>
> \<!\-- Return: Awaiting Parts → In Progress (dashed) \--\>
>
> \<path d=\"M140 411 L250 411\" fill=\"none\"
>
> class=\"arr\" marker-end=\"url(#arrow)\"
>
> stroke-dasharray=\"4 3\"/\>
>
> \<text class=\"ts\" x=\"195\" y=\"430\"
>
> text-anchor=\"middle\"\>Parts received\</text\>

### 4.4.4 Spacing Summary

  ----------------------------------- -----------------------------------
  **Dimension**                       **Value**

  Main-flow box width                 180px (x=250 to x=430)

  Box height (two-line)               56px

  Vertical gap between boxes          54--70px minimum

  Horizontal gap (box edge to box     100px minimum
  edge)                               

  Side-branch box width               120--140px

  Forward arrow y-offset from box top +15px

  Return arrow y-offset from box top  +41px

  Label offset above arrow            −8px from arrow y

  Label offset below arrow            +19px from arrow y
  ----------------------------------- -----------------------------------

## 4.5 Arrow Types

-   **Forward transitions**: Solid lines with class=\"arr\" and
    marker-end=\"url(#arrow)\"

-   **Return transitions**: Dashed lines with stroke-dasharray=\"4 3\"
    added

-   **All arrows** must have activity name labels. No arrow should exist
    without a visible activity name nearby.

## 4.6 Legend

Always include a legend at the bottom of the diagram showing each color
used and its meaning. Also note that solid arrows = forward transitions
and dashed arrows = return transitions. Separate terminal success
(#1E6B45) from terminal failure (#8B2D2D) in the legend.

## 4.7 Interactivity

Wrap each state box in a clickable group that triggers sendPrompt() so
the user can ask about any state:

> \<g class=\"node\" onclick=\"sendPrompt(\'Tell me about the \[State\]
> state\')\"\>

# 5. FACTS Module JSON Structure

Generate a complete JSON file following this exact structure. All fields
below are required unless marked optional.

## 5.1 Top-Level Properties

  ----------------- ----------- --------------------------------------------
  **Property**      **Type**    **Description**

  **name**          string      Module display name

  **icon**          string      Emoji identifier for the module

  **description**   string      Human-readable description for discovery

  **information**   array       Field definitions (see 5.2)

  **states**        array       Workflow states (see 5.3)

  **activities**    array       Custom activities (see 5.4)

  **flows**         array       State transition rules (see 5.5)

  **listings**      array       Named views with filters (see 5.6)

  **documents**     array       Document templates with auto-numbering (see
                                5.7)
  ----------------- ----------- --------------------------------------------

## 5.2 Field Definitions (information)

Each field has a name, type, and optional properties. Available field
types:

  ------------------ ----------------------------------------------------
  **Type**           **Usage**

  Text, MultiText,   Short text, long text, or rich content
  Content            

  Selection, Tag     Single-select or multi-tag with options array

  YesNo              Boolean toggle

  Integer, Number,   Numeric values
  Currency           

  Date, DateTime,    Date/time fields
  DateRange          

  User, Users        Reference to workspace members (needs connection)

  Module, Modules    Reference to another module (needs connection)

  Image, Images,     Attachment fields
  File, Files        

  Table, List        Sub-fields via fields array

  Email, Phone, Link Contact information

  Signature, Formula Signature capture or computed field
  ------------------ ----------------------------------------------------

Add ai_hint to fields that need interpretation guidance for AI agents
(e.g., how to calculate a value, when to set a boolean, what format to
use).

## 5.3 States

Each state requires name and color. Set initial: true on exactly one
state. Use only the 8 hex colors from Section 3. Always include an
ai_hint explaining when an entry should be in this state.

## 5.4 Activities

Each activity defines a custom action. Include:

-   **name** --- Display name of the activity

-   **fields** --- Array of field references with required/readOnly
    constraints

-   **ai_hint** --- When/how an AI agent should perform this activity

-   **confidence_threshold** --- (Optional) Minimum AI confidence (0--1)
    to proceed with the state transition

## 5.5 Flows

Each flow defines a state transition: { from, to, activity }. The from
and to use state names, activity uses the activity name. Every activity
that changes state must have a corresponding flow entry. Ensure no
orphan states (every state should be reachable).

## 5.6 Listings

Listings are pre-configured views. Include at minimum:

-   An \"All Items\" listing showing key columns

-   A \"My Items\" listing filtered by {{currentUser}}

-   One listing per actionable state (e.g., \"Pending Approval\",
    \"Escalated\")

## 5.7 Documents

Define a document template with a name and prefix for auto-numbering.
The prefix generates IDs like PREFIX-YYYY-NNNN (e.g., SVC-2026-0001).

# 6. Design Best Practices

## 6.1 Field Design

1.  Group related fields logically (customer info, issue details,
    technician info, cost tracking).

2.  Use Selection for bounded choices, Tag for open-ended categories.

3.  Use Table type for line items (parts used, checklist items) with
    sub-fields.

4.  Use User type with connection: \"Members\" for assignee fields.

5.  Add ai_hint to any field that requires business logic
    interpretation.

6.  Include file/image fields for supporting documentation and photos.

## 6.2 Workflow Design

1.  Keep the main path linear (top-to-bottom in the diagram).

2.  Add side branches for: external blockers, escalations,
    cancellations.

3.  Always include a cancellation path from early states.

4.  Include a verification/confirmation step before terminal success.

5.  Allow reopening from verification back to active work.

6.  Use confidence_threshold on activities where AI auto-decisions need
    human oversight.

## 6.3 Activity Design

1.  Mark context fields as readOnly in activity forms (so reviewers see
    them but cannot change them).

2.  Mark decision fields as required (e.g., remarks when rejecting,
    feedback when verifying).

3.  Keep activity names short and action-oriented (Triage, Assign,
    Escalate, Resolve, Verify).

4.  Every activity that performs a state transition must have a matching
    flow entry.

# 7. Complete Example: Aircon Service Issues

Below is a complete FACTS module designed for an aircon service company
handling maintenance and repair issues. This serves as the reference
implementation that the AI should follow as a pattern.

## 7.1 States & Transitions

  ---------------- ----------- ---------------------------------------------
  **State**        **Color**   **Purpose**

  **New**          #5A6070     Issue just reported, no action taken

  **Triaged**      #2968A8     Priority assigned, awaiting technician
                               assignment

  **Assigned**     #2968A8     Technician assigned and scheduled, awaiting
                               dispatch

  **In Progress**  #2A7B50     Technician actively working on-site

  **Awaiting       #6B4D91     Blocked --- parts need to be ordered
  Parts**                      

  **Escalated**    #C0392B     SLA breached or senior intervention needed

  **Pending        #2968A8     Repair done, waiting for customer
  Verification**               confirmation

  **Completed**    #1E6B45     Customer verified, issue resolved (terminal)

  **Cancelled**    #8B2D2D     Customer withdrew or duplicate (terminal)
  ---------------- ----------- ---------------------------------------------

## 7.2 Flow Transitions

  ------------------- ------------------- -------------------------------
  **From**            **To**              **Activity**

  New                 Triaged             Triage

  Triaged             Assigned            Assign Technician

  Assigned            In Progress         Start Work

  In Progress         Awaiting Parts      Request Parts

  Awaiting Parts      In Progress         Parts Received

  In Progress         Escalated           Escalate

  Escalated           In Progress         De-escalate

  In Progress         Pending             Resolve
                      Verification        

  Pending             Completed           Verify
  Verification                            

  Pending             In Progress         Reopen
  Verification                            

  Triaged             Cancelled           Cancel

  Assigned            Cancelled           Cancel
  ------------------- ------------------- -------------------------------

## 7.3 Reference JSON

The complete JSON for this example module is provided as a separate file
(aircon-issue-management.json). Use it as the canonical pattern: same
structure, same color logic, same field and activity patterns. When
generating a new module for a different domain, mirror this structure
with domain-appropriate names, fields, and workflow states.

# 8. Output Checklist

Before delivering the final output, verify each item:

## 8.1 Workflow Diagram Checklist

-   Every state box uses the exact hex color from the FACTS palette

-   All text inside state boxes is white (fill=\"#FFFFFF\")

-   Every arrow (vertical and horizontal) has an activity name label

-   Horizontal gaps between boxes are at least 100px to fit labels

-   Bidirectional horizontal arrows are split into two y-positions (top
    and bottom)

-   Labels do not overlap with boxes or other labels

-   Forward arrows are solid, return arrows are dashed
    (stroke-dasharray=\"4 3\")

-   A legend at the bottom shows all colors used

-   Legend separates terminal success from terminal failure

-   All state boxes are clickable via sendPrompt()

## 8.2 JSON Module Checklist

-   Module has name, icon, and description

-   All fields use valid FieldType values from the schema

-   Selection/Tag fields have an options array

-   Table/List fields have a fields array with sub-field definitions

-   User/Users fields have connection: \"Members\"

-   Fields with business logic have ai_hint

-   Exactly one state has initial: true

-   Every state uses one of the 8 palette hex colors

-   Every state has an ai_hint

-   Every activity that changes state has a corresponding flow entry

-   Activity fields use required/readOnly constraints appropriately

-   No orphan states (every state is reachable via at least one flow)

-   Listings include All Items, My Items, and per-actionable-state views

-   Document template has a short prefix for auto-numbering
