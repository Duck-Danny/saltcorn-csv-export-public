const View = require("@saltcorn/data/models/view");
const Table = require("@saltcorn/data/models/table");
const File = require("@saltcorn/data/models/file");
const User = require("@saltcorn/data/models/user");
const { eval_expression } = require("@saltcorn/data/models/expression");

function toCsvValue(val) {
  if (val === null || val === undefined) return "";
  if (typeof val === "object") {
    if (val instanceof Date) return val.toISOString();
    return `"${JSON.stringify(val).replace(/"/g, '""')}"`;
  }
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

module.exports = {
  sc_plugin_api_version: 1,
  actions: {
    export_csv_to_file_public: {
      description: "Export CSV to file (Overwrite & Configurable Role)",
      configFields: async () => {
        // 1. Fetch available CSV Export views
        const views = await View.find({ viewtemplate: "CSV Export" });

        // 2. Fetch roles configured in your Saltcorn instance
        let roleOptions = [
          { label: "Public", value: 100 },
          { label: "User", value: 80 },
          { label: "Staff", value: 40 },
          { label: "Admin", value: 1 },
        ];

        try {
          const dbRoles = await User.get_roles();
          if (dbRoles && dbRoles.length > 0) {
            roleOptions = dbRoles.map((r) => ({
              label: r.role.charAt(0).toUpperCase() + r.role.slice(1),
              value: r.id,
            }));
          }
        } catch (e) {
          // Fall back to standard defaults if roles table isn't reachable
        }

        return [
          {
            name: "view_name",
            label: "Export View",
            type: "String",
            required: true,
            sublabel: "Choose a CSV Export view which will define the columns in the exported CSV file",
            attributes: {
              options: views.map((v) => ({
                label: `${v.name} [CSV Export]`,
                value: v.name,
              })),
            },
          },
          {
            name: "where",
            label: "Where",
            type: "String",
            sublabel: "Only include rows where this formula is true.",
          },
          {
            name: "file_name",
            label: "File name",
            type: "String",
            required: true,
          },
          {
            name: "min_role_read",
            label: "Role access",
            input_type: "select",
            required: true,
            default: 100,
            sublabel: "Minimum role required to access and download this file",
            options: roleOptions,
            attributes: {
              options: roleOptions,
            },
          },
        ];
      },
      run: async ({ configuration, user }) => {
        const { view_name, where, file_name } = configuration;

        // Parse target role (defaults to 100 / Public if not set)
        const targetRole =
          configuration.min_role_read !== undefined && configuration.min_role_read !== null
            ? parseInt(configuration.min_role_read, 10)
            : 100;

        // 1. Resolve View and Table
        const view = await View.findOne({ name: view_name });
        if (!view) throw new Error(`Export view "${view_name}" not found.`);

        const table = Table.findOne({ id: view.table_id });
        if (!table) throw new Error(`Underlying table for view "${view_name}" not found.`);

        // 2. Query rows
        const columns = view.configuration?.columns || [];
        let rows = await table.getJoinedRows({});

        // 3. Apply Where filter if set
        if (where && where.trim()) {
          rows = rows.filter((row) => {
            try {
              return eval_expression(where, row, user);
            } catch (err) {
              return false;
            }
          });
        }

        // 4. Construct CSV text
        const headers = columns.map((col) => col.header || col.field_name || "");
        const csvLines = [headers.map(toCsvValue).join(",")];

        for (const row of rows) {
          const line = columns.map((col) => {
            let val = row[col.field_name];
            if (col.type === "JoinField" && col.join_field) {
              const parts = col.join_field.split(".");
              let cur = row;
              for (const p of parts) cur = cur ? cur[p] : undefined;
              val = cur;
            }
            return toCsvValue(val);
          });
          csvLines.push(line.join(","));
        }
        const csvContent = csvLines.join("\n");

        const targetFilename = file_name.endsWith(".csv") ? file_name : `${file_name}.csv`;

        // 5. Overwrite: Delete previous file if already present
        const existing = await File.findOne({ filename: targetFilename });
        if (existing) {
          await existing.delete();
        }

        // 6. Save file with the chosen role
        const file = await File.from_contents(
          targetFilename,
          "text/csv",
          csvContent,
          user ? user.id : null,
          targetRole
        );

        // Ensure permission is forced in DB record
        if (file && file.id) {
          await File.update(file.id, { min_role_read: targetRole });
        }

        return {
          notify: `Exported ${rows.length} rows to ${targetFilename} with role permission: ${targetRole}.`,
        };
      },
    },
  },
};
