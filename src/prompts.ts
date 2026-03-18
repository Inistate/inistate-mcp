import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPrompts(server: McpServer) {
  // 1. design_factsops_workflow
  server.registerPrompt(
    "design_factsops_workflow",
    {
      description:
        "Guide an AI agent through designing a complete FACTSOps workflow module from scratch.",
      argsSchema: {
        entity: z
          .string()
          .describe(
            "What entity is this workflow about? (e.g., 'leave request', 'invoice', 'KYC application')",
          ),
        industry: z
          .string()
          .optional()
          .describe("Industry context for compliance-aware defaults"),
      },
    },
    async ({ entity, industry }) => {
      const industryLine = industry
        ? `\nIndustry context: ${industry}. Apply compliance-aware defaults for this industry.`
        : "";

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `You are designing a FACTSOps workflow module for: ${entity}${industryLine}

Follow this sequence:
1. Define the entity's information fields (what data is captured)
2. Define the lifecycle states (where the entity can be)
3. Define activities (what actions move the entity between states)
4. Define flows (which activities connect which states)
5. Assign actor types to each activity (human, ai, hybrid)
6. Set confidence thresholds for AI-executed activities
7. Add ai_hints to guide AI agents
8. Assign state colors using the FACTSOps color system:
   - #5A6070 (grey) = not started, idle, queued
   - #2968A8 (blue) = waiting for action, no urgency
   - #2A7B50 (green) = active work in progress
   - #A07828 (amber) = deadline approaching, flagged
   - #C0392B (red) = SLA breached, escalation required
   - #6B4D91 (purple) = blocked by external dependency
   - #1E6B45 (dark green) = terminal success
   - #8B2D2D (dark red) = terminal failure

Rules:
- Every activity must be referenced by at least one flow
- Every activity field must reference a field defined in information
- Exactly one state must be initial
- Terminal states need no outgoing flows
- Use the Three Laws: No transition without a form. No actor without a trail. No automation without escalation.

Use these tools in sequence:
1. Call design_workflow with a description synthesized from user answers
2. Complete the returned template
3. Call validate_design to check for errors
4. Present the schema to the user for review
5. Call create_module to persist it
6. Call get_module_schema to confirm

Output a complete ModuleSchema JSON object.`,
            },
          },
        ],
      };
    },
  );

  // 2. execute_activity
  server.registerPrompt(
    "execute_activity",
    {
      description:
        "Guide an AI agent through executing a specific activity on an entry.",
      argsSchema: {
        module: z.string().describe("Module name"),
        activity: z.string().describe("Activity to execute"),
        entryId: z
          .string()
          .optional()
          .describe("Entry ID (omit for create)"),
      },
    },
    async ({ module: moduleName, activity, entryId }) => {
      const entryLine = entryId
        ? `\nTarget entry ID: ${entryId}`
        : "\nThis is a create operation — no existing entry.";

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `You are executing the "${activity}" activity on module "${moduleName}".${entryLine}

Follow this sequence:
1. Call get_form(module="${moduleName}", activity="${activity}"${entryId ? `, entryId=${entryId}` : ""})
2. Review the required fields, their types, and available options
3. Check if confidence_threshold is present — if so, assess your confidence
4. Prepare the input object with display-name-keyed field values
5. If your confidence is below the threshold, include ai.confidence in the submission — the platform will flag it for human review
6. Call submit_activity with the prepared input
7. Report the result to the user

Always include the ai object with reasoning, sources, model, and confidence.`,
            },
          },
        ],
      };
    },
  );

  // 3. diagnose_entry
  server.registerPrompt(
    "diagnose_entry",
    {
      description:
        "Guide an AI agent through investigating the current state and history of an entry.",
      argsSchema: {
        module: z.string().describe("Module name"),
        entryId: z.string().describe("Entry ID to diagnose"),
      },
    },
    async ({ module: moduleName, entryId }) => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `You are diagnosing entry ${entryId} in module "${moduleName}".

Follow this sequence:
1. Call get_entry(module="${moduleName}", entryId=${entryId}) to see current state and field values
2. Call get_entry_history(module="${moduleName}", entryId=${entryId}) to see the full audit trail
3. Call get_module_schema(module="${moduleName}", tier="extended") to understand available activities
4. Identify: current state, how it got there, what actions are available next, any flagged intentions
5. Summarize findings to the user`,
            },
          },
        ],
      };
    },
  );

  // 4. modify_module
  server.registerPrompt(
    "modify_module",
    {
      description:
        "Guide an AI agent through modifying an existing module's schema — adding fields, states, activities, or flows.",
      argsSchema: {
        module: z.string().describe("Module name to modify"),
        change: z
          .string()
          .describe(
            "Description of the change to make (e.g., 'add a Priority field', 'add an Escalate activity')",
          ),
      },
    },
    async ({ module: moduleName, change }) => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `You are modifying the module "${moduleName}".
Change requested: ${change}

Follow this sequence:
1. Call get_module_canvas(module="${moduleName}") to get the full definition with stable IDs
2. Review the current schema — fields, states, activities, and flows
3. Apply the requested change while preserving all existing stable IDs
4. Call validate_design with the modified schema (mode="update") to check structural integrity
5. If errors: fix and re-validate
6. Present the changes to the user for review
7. Call update_module with the modified schema

Rules:
- Always use get_module_canvas (not get_module_schema) to get stable IDs for update
- Match existing items by their id field to enable renaming without data loss
- Every new activity must be referenced by at least one flow
- Every activity field must reference a field defined in information
- Load inistate://schema resource if you need valid field types, colors, or actor types`,
            },
          },
        ],
      };
    },
  );
}
