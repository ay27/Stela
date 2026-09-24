import mysqlPlugin from "../../connector-mysql/src/index";
import { CONNECTOR_PLUGIN_API_VERSION, defineConnectorPlugin } from "@stela/connector-plugin-sdk";

// Doris FE speaks the MySQL wire protocol; keep the shared transport and
// declare its own kind/dialect so Agent and connection management identify it.
export default defineConnectorPlugin({
  apiVersion: CONNECTOR_PLUGIN_API_VERSION,
  create(ctx) {
    const connector = mysqlPlugin.create(ctx);
    const mysqlMeta = connector.meta();
    connector.meta = () => ({
      ...mysqlMeta,
      kind: "doris",
      displayName: "Apache Doris",
      dialect: "Doris",
      defaultConfig: { ...mysqlMeta.defaultConfig as object, port: 9030 },
      configSchema: {
        ...mysqlMeta.configSchema as object,
        properties: { ...(mysqlMeta.configSchema as { properties: object }).properties,
          port: { type: "integer", default: 9030 } },
      },
    });
    return connector;
  },
});
