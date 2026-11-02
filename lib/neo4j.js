/**
 * Direct Neo4j (Bolt) client for DocChain's knowledge graph.
 *
 * The knowledge graph lives in Neo4j:
 *   - the fact/entity graph in database `neo4j` (labels Document / Entity /
 *     ontology, relationship CONTAINS),
 *   - one document-map database per topic: `docchaintopic{topic_id}`.
 *
 * Output serialisation strips the bulky `embedding` vector and `origin_json`
 * blob from node properties and converts driver types (Integer/Date/…) to
 * plain JSON so tool results stay readable.
 */

import neo4j from 'neo4j-driver';

const SKIP_PROPS = new Set(['embedding', 'origin_json']);

/** Convert neo4j driver types into plain JSON-safe values. */
function toPlain(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (neo4j.isInt(value)) return value.inSafeRange() ? value.toNumber() : value.toString();
  if (neo4j.isDate(value) || neo4j.isDateTime(value) || neo4j.isLocalDateTime(value)) return value.toString();
  if (neo4j.isTime(value) || neo4j.isLocalTime(value) || neo4j.isDuration(value) || neo4j.isPoint(value)) {
    return value.toString();
  }
  if (neo4j.isNode(value)) {
    const props = {};
    for (const [k, v] of Object.entries(value.properties)) {
      if (SKIP_PROPS.has(k)) continue;
      props[k] = toPlain(v, depth + 1);
    }
    return { _labels: [...value.labels], _id: value.elementId, ...props };
  }
  if (neo4j.isRelationship(value)) {
    const props = {};
    for (const [k, v] of Object.entries(value.properties)) {
      if (SKIP_PROPS.has(k)) continue;
      props[k] = toPlain(v, depth + 1);
    }
    return { _type: value.type, _from: value.startNodeElementId, _to: value.endNodeElementId, ...props };
  }
  if (neo4j.isPath(value)) return toPlain(value.segments.map((s) => [s.start, s.relationship, s.end]), depth + 1);
  if (Array.isArray(value)) return value.map((v) => toPlain(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = toPlain(value[k], depth + 1);
    return out;
  }
  return value;
}

/**
 * Guard a user-supplied Cypher query: append `LIMIT n` when it would otherwise
 * return an unbounded result set.
 */
export function guardCypher(cypher, limit = 50) {
  let c = String(cypher).trim().replace(/;+\s*$/, '');
  if (
    !/\blimit\b/i.test(c) &&
    !/\bcount\s*\(/i.test(c) &&
    !/\bcollect\s*\(/i.test(c) &&
    !/\bskip\b/i.test(c) &&
    !/^call\b/i.test(c) &&
    !/^show\b/i.test(c)
  ) {
    c = `${c} LIMIT ${limit}`;
  }
  return c;
}

/**
 * Convert a JS value into a driver-ready value: whole numbers become Neo4j
 * integers (LIMIT/SKIP and other integer parameters require this), while
 * arrays/objects are converted recursively.
 */
function toDriverValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? neo4j.int(value) : value;
  }
  if (Array.isArray(value)) return value.map(toDriverValue);
  if (value instanceof Map) {
    const out = {};
    for (const [k, v] of value) out[k] = toDriverValue(v);
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toDriverValue(v);
    return out;
  }
  return value;
}

export class Neo4jClient {
  constructor({ logger } = {}) {
    this.logger = logger;
    this.driver = null;
    this.key = '';
  }

  async _driver(conn) {
    const key = `${conn.uri}\u0000${conn.user}\u0000${conn.password}`;
    if (this.driver && this.key === key) return this.driver;
    if (this.driver) await this.driver.close().catch(() => {});
    this.driver = neo4j.driver(conn.uri, neo4j.auth.basic(conn.user, conn.password), {
      connectionTimeout: conn.timeoutMs || 30000,
      maxTransactionRetryTime: (conn.timeoutMs || 30000) - 1000,
    });
    this.key = key;
    return this.driver;
  }

  /** Run a query; returns { keys, records } with plain JSON values. */
  async run(conn, cypher, params = {}, db) {
    const driver = await this._driver(conn);
    const session = driver.session({ database: db || conn.database || 'neo4j' });
    try {
      const result = await session.run(cypher, toDriverValue(params));
      const records = result.records.map((record) => {
        const out = {};
        for (const key of record.keys) out[key] = toPlain(record.get(key));
        return out;
      });
      const first = result.records[0];
      const keys = first ? [...first.keys] : [];
      return { keys, records };
    } finally {
      await session.close();
    }
  }

  /** Run a write query; returns the summary counters as plain numbers. */
  async write(conn, cypher, params = {}, db) {
    const res = await this.writeResult(conn, cypher, params, db);
    return res.counters;
  }

  /**
   * Run a write query and return both the summary counters and the result
   * records (for statements that RETURN generated ids or properties).
   */
  async writeResult(conn, cypher, params = {}, db) {
    const driver = await this._driver(conn);
    const session = driver.session({ database: db || conn.database || 'neo4j' });
    try {
      const result = await session.run(cypher, toDriverValue(params));
      const counters = result.summary.counters;
      const stats = counters && typeof counters._stats === 'object' ? counters._stats : counters;
      const pick = (key) => {
        const value = stats ? stats[key] : 0;
        return value === undefined || value === null ? 0 : toPlain(value);
      };
      const summary = {
        nodesCreated: pick('nodesCreated'),
        nodesDeleted: pick('nodesDeleted'),
        relationshipsCreated: pick('relationshipsCreated'),
        relationshipsDeleted: pick('relationshipsDeleted'),
        propertiesSet: pick('propertiesSet'),
        labelsAdded: pick('labelsAdded'),
        labelsRemoved: pick('labelsRemoved'),
      };
      const records = result.records.map((record) => {
        const out = {};
        for (const key of record.keys) out[key] = toPlain(record.get(key));
        return out;
      });
      const first = result.records[0];
      const keys = first ? [...first.keys] : [];
      return { counters: summary, keys, records };
    } finally {
      await session.close();
    }
  }

  async listDatabases(conn) {
    const { records } = await this.run(conn, 'SHOW DATABASES YIELD name, currentStatus', {}, 'system');
    return records.map((r) => r.name).filter((n) => typeof n === 'string');
  }

  async listLabels(conn, db) {
    const { records } = await this.run(conn, 'CALL db.labels() YIELD label RETURN label ORDER BY label', {}, db);
    return records.map((r) => r.label);
  }

  async listRelationshipTypes(conn, db) {
    const { records } = await this.run(
      conn,
      'CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType',
      {},
      db,
    );
    return records.map((r) => r.relationshipType);
  }

  async countByLabel(conn, db) {
    const { records } = await this.run(
      conn,
      'MATCH (n) RETURN labels(n)[0] AS label, count(*) AS count ORDER BY count DESC',
      {},
      db,
    );
    return records;
  }

  async close() {
    if (this.driver) await this.driver.close().catch(() => {});
    this.driver = null;
    this.key = '';
  }
}
