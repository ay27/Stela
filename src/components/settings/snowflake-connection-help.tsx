import { useState } from "react";
import { Copy } from "lucide-react";
import { useT } from "@/i18n/use-t";

// A single read-only statement for Snowsight. Keep the query IDs explicitly:
// LAST_QUERY_ID offsets are fragile inside a scripting block.
const CONNECTION_SQL = `EXECUTE IMMEDIATE $$
DECLARE
  describe_user_sql VARCHAR DEFAULT
    'DESCRIBE USER "' || REPLACE(CURRENT_USER(), '"', '""') || '"';
  user_query_id VARCHAR;
  token_query_id VARCHAR;
  connection_fields RESULTSET;
BEGIN
  EXECUTE IMMEDIATE :describe_user_sql;
  user_query_id := SQLID;
  SHOW USER PROGRAMMATIC ACCESS TOKENS;
  token_query_id := SQLID;
  connection_fields := (
    SELECT
      CURRENT_ORGANIZATION_NAME() || '-' || CURRENT_ACCOUNT_NAME() AS "account",
      u."value" AS "username",
      CURRENT_WAREHOUSE() AS "warehouse",
      CURRENT_DATABASE() AS "database",
      CURRENT_SCHEMA() AS "schema",
      COALESCE(NULLIF(t."role_restriction", ''), CURRENT_ROLE()) AS "role",
      t."name" AS "token_name",
      t."status" AS "token_status",
      t."expires_at" AS "token_expires_at"
    FROM TABLE(RESULT_SCAN(:user_query_id)) u
    LEFT JOIN TABLE(RESULT_SCAN(:token_query_id)) t ON TRUE
    WHERE u."property" = 'LOGIN_NAME'
  );
  RETURN TABLE(connection_fields);
END;
$$;`;

export function SnowflakeConnectionHelp() {
  const t = useT();
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const copy = () => {
    try {
      window.stela.shell.writeClipboardText(CONNECTION_SQL);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  };

  return (
    <div className="stela-snowflake-connection-help mb-3 text-xs leading-relaxed text-muted-foreground">
      <p>{t("connections.snowflake.help.intro")}</p>
      <details className="mt-1.5">
        <summary className="cursor-pointer text-foreground hover:text-primary">
          {t("connections.snowflake.help.title")}
        </summary>
        <div className="mt-2 space-y-3 border-l border-border pl-3">
          <div>
            <p className="font-medium text-foreground">{t("connections.snowflake.help.passwordTitle")}</p>
            <p>{t("connections.snowflake.help.passwordSteps")}</p>
          </div>
          <div>
            <p className="font-medium text-foreground">{t("connections.snowflake.help.tokenTitle")}</p>
            <p>{t("connections.snowflake.help.tokenSteps")}</p>
            <button type="button" className="mt-1 text-primary hover:underline" onClick={() => void window.stela.shell.openExternal("https://docs.snowflake.com/en/user-guide/programmatic-access-tokens#generating-a-programmatic-access-token")}>
              {t("connections.snowflake.help.tokenGuide")}
            </button>
            <p className="mt-2">{t("connections.snowflake.help.networkSteps")}</p>
            <button type="button" className="mt-1 text-primary hover:underline" onClick={() => void window.stela.shell.openExternal("https://docs.snowflake.com/en/user-guide/network-policies")}>
              {t("connections.snowflake.help.networkGuide")}
            </button>
          </div>
          <div>
            <p className="font-medium text-foreground">{t("connections.snowflake.help.queryTitle")}</p>
            <p>{t("connections.snowflake.help.querySteps")}</p>
            <div className="my-2 min-w-0 overflow-hidden rounded-md border border-border">
              <div className="flex justify-end border-b border-border px-2 py-1">
                <button type="button" onClick={copy} className="inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-accent hover:text-foreground">
                  <Copy className="h-3 w-3" />
                  {t(copyStatus === "copied" ? "common.copied" : "common.copy")}
                </button>
              </div>
              <pre className="max-h-56 overflow-auto bg-muted/30 p-2 font-mono text-[11px] select-text"><code>{CONNECTION_SQL}</code></pre>
            </div>
            {copyStatus === "error" ? <p role="alert" className="text-destructive">{t("connections.snowflake.help.copyFailed")}</p> : null}
            <p>{t("connections.snowflake.help.queryResult")}</p>
          </div>
        </div>
      </details>
    </div>
  );
}
