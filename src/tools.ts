import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as api from "./api.js";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

export function registerTools(server: McpServer) {
  // 1. list_modules
  server.registerTool(
    "list_modules",
    {
      description:
        "List all discoverable modules in the current workspace. Call this first to find the moduleId for subsequent operations.",
      inputSchema: {},
    },
    async () => {
      try {
        const data = await api.get("/api/m/discovery");
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // 2. get_module_canvas
  server.registerTool(
    "get_module_canvas",
    {
      description:
        "Get the canvas schema for a module: information fields, states, and listings (basic tier), plus activities and flows (extended tier). Use listings[].id as listingId for list_entries.",
      inputSchema: {
        moduleId: z.string().describe("Module ID from list_modules"),
        tier: z
          .enum(["basic", "extended"])
          .default("basic")
          .describe("Schema detail level"),
      },
    },
    async ({ moduleId, tier }) => {
      try {
        const data = await api.get(`/api/m/${moduleId}/discovery?tier=${tier}`);
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // 3. list_entries
  server.registerTool(
    "list_entries",
    {
      description:
        `Query entries from a module listing with optional filters and sorting. Use display names for field references in filters and sortBy.

Filters are keyed by display name. Values can be:
- Simple equality: { "Priority": "High" }
- Comparison: { "Start Date": { "$gte": "2026-01-01T00:00:00Z" } }

Supported filter operators by field type:
- Text/Select/Tag/Email/Phone/Link: $contains, $startsWith, $endsWith, $eq, $none
- Number/Integer/Currency: $gte, $gt, $lte, $lt, $eq, $between ({"$between":{"min":1,"max":10}}), $none
- Date/DateTime: $gte, $gt, $lte, $lt, $eq, $between ({"$between":{"startDate":"...","endDate":"..."}}), $within/$in/$past ({"$in":{"duration":"day"|"week"|"month","offset":7}}), $none
- YesNo: $yes, $no, $none
- User/Users: $is, $contains, $me (current user), $none
- State: $is, $isNot (use state name as value)

Multiple filters are AND-ed. If listingId has profileOnly, a current-user filter is auto-added.`,
      inputSchema: {
        moduleId: z.string().describe("Module ID"),
        listingId: z
          .string()
          .optional()
          .describe("Listing ID from get_module_canvas listings[]"),
        filters: z
          .record(z.unknown())
          .optional()
          .describe(
            'Display-name-keyed filter object. Equality: {"Priority":"High"}. Operators: {"Start Date":{"$gte":"2026-01-01"}}',
          ),
        sortBy: z.string().optional().describe("Field displayName to sort by"),
        sortDirection: z.enum(["asc", "desc"]).default("asc").optional(),
        page: z.number().int().default(0).optional(),
        pageSize: z
          .number()
          .int()
          .default(50)
          .optional()
          .describe("Max 500"),
      },
    },
    async ({ moduleId, listingId, filters, sortBy, sortDirection, page, pageSize }) => {
      try {
        const body: Record<string, unknown> = { moduleId };
        if (listingId) body.listingId = listingId;
        if (filters) body.filters = filters;
        if (sortBy) body.sortBy = sortBy;
        if (sortDirection) body.sortDirection = sortDirection;
        if (page !== undefined) body.page = page;
        if (pageSize !== undefined) body.pageSize = pageSize;
        const data = await api.post("/api/m/list", body);
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // 4. get_entry
  server.registerTool(
    "get_entry",
    {
      description:
        "Read a single entry by its ID. Returns current field values for the entry.",
      inputSchema: {
        moduleId: z.string().describe("Module ID"),
        entryId: z.union([z.string(), z.number()]).describe("Entry ID"),
        listingId: z.string().optional().describe("Optional listing context"),
      },
    },
    async ({ moduleId, entryId, listingId }) => {
      try {
        const body: Record<string, unknown> = {
          moduleId,
          activityId: "view",
          entryId,
        };
        if (listingId) body.listingId = listingId;
        const data = await api.post("/api/m/form", body);
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // 5. get_form
  server.registerTool(
    "get_form",
    {
      description:
        "Get the form fields and current values for a module activity. Use before submit_activity to discover required fields and their types. For edit/view, provide entryId to get current values.",
      inputSchema: {
        moduleId: z.string().describe("Module ID from list_modules"),
        activityId: z
          .string()
          .default("create")
          .describe("Activity: create, edit, view, or custom activity name"),
        entryId: z
          .union([z.string(), z.number(), z.null()])
          .optional()
          .describe("Entry ID for edit/view/custom activities"),
      },
    },
    async ({ moduleId, activityId, entryId }) => {
      try {
        const body: Record<string, unknown> = { moduleId, activityId };
        if (entryId !== undefined && entryId !== null) body.entryId = entryId;
        const data = await api.post("/api/m/form", body);
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // 6. submit_activity
  server.registerTool(
    "submit_activity",
    {
      description:
        "Perform an activity on a module entry. Use activityId 'create' (no entryId), 'edit', 'delete', or any custom activity name from get_module_canvas activities[].",
      inputSchema: {
        moduleId: z.string().describe("Module ID"),
        activityId: z
          .string()
          .default("create")
          .describe(
            "Standard: create, edit, delete. Custom: use activity name from get_module_canvas.",
          ),
        entryId: z
          .union([z.string(), z.number()])
          .optional()
          .describe("Required for edit, delete, and custom activities. Omit for create."),
        payload: z
          .record(z.unknown())
          .optional()
          .describe("Field values keyed by information[].name (displayName)"),
        state: z
          .string()
          .optional()
          .describe("Target state name (resolved to stateId internally)"),
        comment: z
          .string()
          .optional()
          .describe("Optional comment to attach to the activity"),
        assignees: z
          .array(z.string())
          .optional()
          .describe("Usernames to assign"),
        due: z
          .string()
          .optional()
          .describe("Due date for assignment (ISO 8601)"),
      },
    },
    async ({ moduleId, activityId, entryId, payload, state, comment, assignees, due }) => {
      try {
        const body: Record<string, unknown> = { moduleId, activityId };
        if (entryId !== undefined) body.entryId = entryId;
        if (payload) body.payload = payload;
        if (state) body.state = state;
        if (comment) body.comment = comment;
        if (assignees) body.assignees = assignees;
        if (due) body.due = due;
        const data = await api.post("/api/m/activity", body);
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // 7. get_audit_trail
  server.registerTool(
    "get_audit_trail",
    {
      description:
        "Get the audit trail and comments for an entry. Returns chronological list of actions (create, edit, state changes, comments) with field-level change details.",
      inputSchema: {
        moduleId: z.string().describe("Module ID from list_modules"),
        entryId: z
          .union([z.string(), z.number()])
          .describe("Entry ID to get history for"),
        page: z
          .number()
          .int()
          .default(0)
          .optional()
          .describe("Page number (0-based, 50 items per page)"),
      },
    },
    async ({ moduleId, entryId, page }) => {
      try {
        const body: Record<string, unknown> = { moduleId, entryId };
        if (page !== undefined) body.page = page;
        const data = await api.post("/api/m/history", body);
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // 8. create_module
  server.registerTool(
    "create_module",
    {
      description:
        "Create a new module in the current workspace with information fields, states, activities, and flows.",
      inputSchema: {
        name: z.string().describe("Module name"),
        icon: z.string().optional().describe("Emoji identifier"),
        description: z.string().optional(),
        published: z.boolean().default(true).optional(),
        information: z
          .array(
            z.object({
              name: z.string(),
              type: z.string().optional(),
              options: z.array(z.string()).optional(),
            }),
          )
          .optional()
          .describe("Field definitions"),
        states: z
          .array(
            z.object({
              name: z.string(),
              initial: z.boolean().optional(),
            }),
          )
          .optional()
          .describe("Workflow states"),
        activities: z
          .array(
            z.object({
              name: z.string(),
              fields: z.array(z.string()).optional(),
            }),
          )
          .optional()
          .describe("Activities with form field assignments"),
        flows: z
          .array(
            z.object({
              from: z.string(),
              to: z.string(),
              activity: z.string(),
            }),
          )
          .optional()
          .describe("State transition rules"),
      },
    },
    async ({ name, icon, description, published, information, states, activities, flows }) => {
      try {
        const body: Record<string, unknown> = { name };
        if (icon) body.icon = icon;
        if (description) body.description = description;
        if (published !== undefined) body.published = published;
        if (information) body.information = information;
        if (states) body.states = states;
        if (activities) body.activities = activities;
        if (flows) body.flows = flows;
        const data = await api.post("/api/m/", body);
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // 9. update_module
  server.registerTool(
    "update_module",
    {
      description:
        "Update an existing module's schema. Merges changes into the existing canvas, preserving internal IDs for items matched by name.",
      inputSchema: {
        moduleId: z.string().describe("Module ID to update"),
        name: z.string().optional(),
        icon: z.string().optional(),
        description: z.string().optional(),
        published: z.boolean().optional(),
        information: z
          .array(
            z.object({
              name: z.string(),
              type: z.string().optional(),
              options: z.array(z.string()).optional(),
            }),
          )
          .optional(),
        states: z
          .array(
            z.object({
              name: z.string(),
              initial: z.boolean().optional(),
            }),
          )
          .optional(),
        activities: z
          .array(
            z.object({
              name: z.string(),
              fields: z.array(z.string()).optional(),
            }),
          )
          .optional(),
        flows: z
          .array(
            z.object({
              from: z.string(),
              to: z.string(),
              activity: z.string(),
            }),
          )
          .optional(),
      },
    },
    async ({ moduleId, name, icon, description, published, information, states, activities, flows }) => {
      try {
        const body: Record<string, unknown> = {};
        if (name) body.name = name;
        if (icon) body.icon = icon;
        if (description) body.description = description;
        if (published !== undefined) body.published = published;
        if (information) body.information = information;
        if (states) body.states = states;
        if (activities) body.activities = activities;
        if (flows) body.flows = flows;
        const data = await api.put(`/api/m/${moduleId}`, body);
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
