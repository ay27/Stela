import mysqlPlugin from "../../connector-mysql/src/index";
import { CONNECTOR_PLUGIN_API_VERSION, defineConnectorPlugin } from "@stela/connector-plugin-sdk";

// StarRocks speaks MySQL wire protocol; keep one transport implementation while
// advertising the correct dialect to schema completion and the Agent.
export default defineConnectorPlugin({
  apiVersion: CONNECTOR_PLUGIN_API_VERSION,
  create(ctx) {
    const connector = mysqlPlugin.create(ctx);
    const mysqlMeta = connector.meta();
    connector.meta = () => ({
      ...mysqlMeta,
      kind: "starrocks",
      displayName: "StarRocks",
      dialect: "StarRocks",
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
