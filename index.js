const View = require("@saltcorn/data/models/view");
const Table = require("@saltcorn/data/models/table");
const File = require("@saltcorn/data/models/file");
const User = require("@saltcorn/data/models/user");
const { eval_expression } = require("@saltcorn/data/models/expression");

/**
 * Escapes values to RFC 4180 CSV standard
 */
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
        // 1. Fetch CSV Export views and build { label, value } options
        const views = await View.find({ viewtemplate: "CSV Export" });
        const viewOptions = views.map((v) => {
          if (v.select_option) return v.select_option;
          return {
            label: `${v.name} [CSV Export]`,
            value: v.name,
          };
        });

        // 2. Fetch roles with safe default fallback
        let roleOptions = [
          { label: "Public", value: 100 },
          { label: "User", value: 80 },
          { label: "Staff", value: 40 },
          { label: "Admin", value: 1 },
        ];
        try {
          if (User && typeof User.get_roles === "function") {
            const dbRoles = await User.get_roles();
            if (Array.isArray(dbRoles) && dbRoles.length > 0) {
              roleOptions = dbRoles.map((r) => ({
                label: r.role ? r.role.charAt(0).toUpperCase() + r.role.slice(1) : String(r.id),
                value: r.id,
              }));
            }
          }
        } catch (e) {}

        return [
          {
            name: "view_name",
            label: "Export View",
            input_type: "select",
            options: viewOptions,
            required: true,
            sublabel:
              "Choose a CSV Export view which will define the columns in the exported CSV file",
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
            name: "role_id",
            label: "Role access",
            input_type: "select",
            options: roleOptions,
            default: 100,
            sublabel: "Minimum role required to access and download this file",
          },
        ];
      },
      run: async ({ configuration, user }) => {
        const { view_name, where, file_name, role_id } = configuration || {};

        // 1. Resolve numeric role ID (100 = Public)
        let targetRoleId = 100;
        if (role_id !== undefined && role_id !== null && !isNaN(parseInt(role_id, 10))) {
          targetRoleId = parseInt(role_id, 10);
        }

        // 2. Resolve View (checks slug or label)
        const rawName = String(view_name || "").trim();
        const strippedName = rawName.replace(/\s*\[.*?\]$/, "").trim();

        let view = await View.findOne({ name: strippedName });
        if (!view) {
          view = await View.findOne({ name: rawName });
        }
        if (!view) {
          throw new Error(`Export view "${view_name || ""}" could not be found.`);
        }

        // 3. Resolve Table
        const table = Table.findOne({ id: view.table_id }) || Table.findOne(view.table_id);
        if (!table) {
          throw new Error(`Underlying table for view "${view.name}" not found.`);
        }

        // 4. Fetch columns and rows
        let columns = view.configuration?.columns;
        if (!columns || columns.length === 0) {
          const fields = await table.getFields();
          columns = fields
            .filter((f) => !f.calculated)
            .map((f) => ({ field_name: f.name, header: f.label || f.name }));
        }

        let rows = await table.getJoinedRows({});

        // 5. Apply Where filter if provided
        if (where && typeof where === "string" && where.trim()) {
          rows = rows.filter((row) => {
            try {
              return Boolean(eval_expression(where, row, user));
            } catch (err) {
              return false;
            }
          });
        }

        // 6. Build CSV string
        const headers = columns.map((col) => col.header || col.field_name || "");
        const csvLines = [headers.map(toCsvValue).join(",")];

        for (const row of rows) {
          const line = columns.map((col) => {
            let val = row[col.field_name];
            if (col.type === "JoinField" && col.join_field) {
              const parts = col.join_field.split(".");
              let cur = row;
              for (const p of parts) {
                cur = cur ? cur[p] : undefined;
              }
              val = cur;
            }
            return toCsvValue(val);
          });
          csvLines.push(line.join(","));
        }
        const csvContent = csvLines.join("\n");

        // 7. Resolve output file name
        const rawFileName = (file_name || "").trim() || view.name || "export";
        const baseFileName = rawFileName.endsWith(".csv")
          ? rawFileName.slice(0, -4)
          : rawFileName;
        const targetFilename = `${baseFileName}.csv`;

        // 8. Delete previous file from disk and database (prevents _1.csv collision)
        const existing = await File.findOne({ filename: targetFilename });
        if (existing) {
          await existing.delete();
        }

        // 9. Write the new file and ensure permissions
        const file = await File.from_contents(
          targetFilename,
          "text/csv",
          csvContent,
          user ? user.id : null,
          targetRoleId
        );

        if (file && file.id) {
          await File.update(file.id, { min_role_read: targetRoleId });
        }

        return {
          notify: `Exported ${rows.length} rows to ${targetFilename} (Role: ${targetRoleId}).`,
        };
      },
    },
  },
};
