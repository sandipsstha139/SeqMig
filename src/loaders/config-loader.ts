import fs from "fs";
import path from "path";

export interface SeqmigConfig {
  configFile: string;
  modelsPath: string;
  migrationDir: string;
  seedersPath: string;
  snapshotDir: string;
  url?: string;
  debug?: boolean;
  tsconfigPath?: string;
}

export function loadSeqmigConfig(): SeqmigConfig {
  const rcPath = path.join(process.cwd(), ".sequelizerc");

  let rc: any = {};
  if (fs.existsSync(rcPath)) {
    rc = require(rcPath) ?? {};
  }

  const resolve = (p: string | undefined, fallback: string) =>
    !p
      ? path.resolve(fallback)
      : path.isAbsolute(p)
        ? p
        : path.resolve(process.cwd(), p);

  return {
    configFile: resolve(rc.config, "config/config.js"),
    modelsPath: resolve(rc["models-path"], "models"),
    migrationDir: resolve(rc["migrations-path"], "migrations"),
    seedersPath: resolve(rc["seeders-path"], "seeders"),
    snapshotDir: path.resolve(".seqmig/snapshots"),
    url: rc.url,
    debug: rc.debug,
    tsconfigPath: rc["tsconfig-path"],
  };
}

export function loadSequelizeConfig(): any {
  const cfg = loadSeqmigConfig();

  if (cfg.url) {
    return {
      url: cfg.url,
      dialect: "postgres",
      logging: false,
    };
  }

  const configPath = cfg.configFile;

  if (!fs.existsSync(configPath)) {
    throw new Error(`Sequelize config file not found: ${configPath}`);
  }

  delete require.cache[require.resolve(configPath)];
  const config = require(configPath);

  const env = process.env.NODE_ENV || "development";
  const db = config[env] || config;

  if (!db.username) throw new Error(`Missing username in Sequelize config`);
  if (!db.database) throw new Error(`Missing database in Sequelize config`);
  if (!db.host) throw new Error(`Missing host in Sequelize config`);

  return {
    username: String(db.username),
    password: db.password ? String(db.password) : "",
    database: String(db.database),
    host: String(db.host),
    port: Number(db.port || 5432),
    dialect: db.dialect || "postgres",
    logging: false,
  };
}

export function initConfig() {
  const rcPath = path.join(process.cwd(), ".sequelizerc");

  if (fs.existsSync(rcPath)) {
    console.log(".sequelizerc already exists");
    return;
  }

  const template = `
const path = require("path");

module.exports = {
  config: path.resolve("config/config.js"),
  "models-path": path.resolve("models"),
  "migrations-path": path.resolve("migrations"),
  "seeders-path": path.resolve("seeders")
};
`.trimStart();

  fs.writeFileSync(rcPath, template);
  console.log("Created .sequelizerc");
}
