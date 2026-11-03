const View = require("@saltcorn/data/models/view");
const Table = require("@saltcorn/data/models/table");
const File = require("@saltcorn/data/models/file");
const User = require("@saltcorn/data/models/user");
const { eval_expression } = require("@saltcorn/data/models/expression");
const { getState } = require("@saltcorn/data/db/state");

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
        // 1. Fetch CSV Export views and map to plain strings (matches csv-io exactly)
        const views = await View.find({ viewtemplate: "CSV Export" });
        const viewOptions = views.map((v) => `${v.name} [CSV Export]`);

        // 2. Fetch roles as plain strings
        let roleOptions = ["public", "user", "staff", "admin"];
        try {
          const dbRoles = await User.get_roles();
          if (dbRoles && dbRoles.length > 0) {
            roleOptions = dbRoles.map((r) => r.role);
          }
        } catch (e) {
          // fallback to defaults
        }

        return [
          {
            name: "view_name",
            label: "Export View",
            type: "String",
            required: true,
            sublabel: "Choose a CSV Export view which will define the columns in the exported CSV file",
            attributes: {
              options: viewOptions,
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
            name: "role_name",
            label: "Role access",
            type: "String",
            required: true,
            default: "public",
            sublabel: "Minimum role required to access and download this file",
            attributes: {
              options: roleOptions,
            },
          },
        ];
      },
      run: async ({ configuration, user }) => {
        const { view_name, where, file_name, role_name } = configuration;

        // 1. Resolve numeric role ID
        const roleMap = { admin: 1, staff: 40, user: 80, public: 100 };
        let targetRoleId = roleMap[(role_name || "public").toLowerCase()] || 100;
        try {
          const dbRoles = await User.get_roles();
          const match = dbRoles.find(
            (r) => r.role.toLowerCase() === (role_name || "").toLowerCase()
          );
          if (match) targetRoleId = match.id;
        } catch (e) {}

        const baseFileName = file_name.endsWith(".csv") ? file_name.slice(0, -4) : file_name;
        const targetFilename = `${baseFileName}.csv`;

        // 2. Overwrite protection: Delete existing file before running export
        const existing = await File.findOne({ filename: targetFilename });
        if (existing) {
          await existing.delete();
        }

        // 3. If csv-io's native action is registered, delegate the export to it
        const originalAction = getState().actions["export_csv_to_file"];
        if (originalAction && typeof originalAction.run === "function") {
          await originalAction.run({
            configuration: {
              view_name,
              where,
              file_name: baseFileName,
            },
            user,
          });
        } else {
          // Fallback manual exporter if csv-io action is unreachable
          const cleanName = (view_name || "").replace(/\s*\[.*?\]$/, "").trim();
          let view = await View.findOne({ name: cleanName });
          if (!view) view = await View.findOne({ name: view_name });
          if (!view) throw new Error(`Export view "${view_name}" not found.`);

          const table = Table.findOne({ id: view.table_id });
          if (!table) throw new Error(`Table for view "${view_name}" not found.`);

          const columns = view.configuration?.columns || [];
          let rows = await table.getJoinedRows({});

          if (where && where.trim()) {
            rows = rows.filter((row) => {
              try {
                return eval_expression(where, row, user);
              } catch (err) {
                return false;
              }
            });
          }

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

          await File.from_contents(
            targetFilename,
            "text/csv",
            csvLines.join("\n"),
            user ? user.id : null,
            targetRoleId
          );
        }

        // 4. Force chosen access role on the created file record
        const createdFile = await File.findOne({ filename: targetFilename });
        if (createdFile && createdFile.id) {
          await File.update(createdFile.id, { min_role_read: targetRoleId });
        }

        return {
          notify: `Exported to ${targetFilename} (${role_name || "public"}).`,
        };
      },
    },
  },
};
