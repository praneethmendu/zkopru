import sqlite3 from 'sqlite3'
import { open, Database, ISqlite } from 'sqlite'
import {
  DB,
  WhereClause,
  DeleteManyOptions,
  FindManyOptions,
  FindOneOptions,
  UpdateOptions,
  UpsertOptions,
  TableData,
  normalizeRowDef,
  constructSchema,
  Schema,
  Relation,
} from '../types'

const escapeQuotes = (str: string) => str.replace(/"/gm, '""')

export class SQLiteConnector implements DB {
  db: Database<sqlite3.Database, sqlite3.Statement>

  config: {
    filename: string
  } & any

  schema: Schema = {}

  constructor(config: ISqlite.Config) {
    this.config = config
    this.db = {} as any
  }

  async init() {
    this.db = await open(this.config)
  }

  static async create(_config: ISqlite.Config | string) {
    const config =
      typeof _config === 'string'
        ? {
            filename: _config,
            driver: sqlite3.Database,
          }
        : _config
    const connector = new this(config)
    await connector.init()
    return connector
  }

  whereToSql(
    collection: string,
    doc: any = {},
    joinWith = '=',
  ) {
    if (Object.keys(doc).length === 0) return ''
    const table = this.schema[collection]
    if (!table) throw new Error(`Unable to find table ${collection} in schema`)
    const parseType = (type: string, value: any) => {
      if (value === null) return 'NULL'
      if (type === 'String') {
        return `"${escapeQuotes(value)}"`
      }
      if (type === 'Int') {
        return value
      }
      if (type === 'Bool') {
        return value ? 'true' : 'false'
      }
      if (type === 'Object') {
        return `"${escapeQuotes(JSON.stringify(value))}"`
      }
      throw new Error(`Unrecognized type ${type}`)
    }
    const sql = Object.keys(doc)
      .map(key => {
        const rowDef = table.rows[key]
        if (!rowDef)
          throw new Error(`Unable to find row definition for key: "${key}"`)
        const val = doc[key]
        if (Array.isArray(val)) {
          // need to generate an IN query
          const values = val.map(v => parseType(rowDef.type, v))
          return `"${key}" IN (${values.join(',')})`
        }
        const parsed = parseType(rowDef.type, val)
        return `"${key}" ${parsed === 'NULL' ? 'IS' : joinWith} ${parsed}`
      })
      .join(' AND ')
    return ` WHERE ${sql} `
  }

  async create(
    collection: string,
    _doc: any | any,
  ): Promise<number> {
    const table = this.schema[collection]
    if (!table) throw new Error(`Unable to find table ${collection} in schema`)
    // create defaults where needed
    const docs = [_doc].flat()
    for (const [, row] of Object.entries(table.rows)) {
      for (const doc of docs) {
        if (
          !row?.default ||
          (doc[row.name] !== undefined && doc[row.name] !== null)
        )
          // eslint-disable-next-line no-continue
          continue
        // otherwise generate default field
        Object.assign(doc, {
          [row.name]:
            typeof row.default === 'function' ? row.default() : row.default,
        })
      }
    }
    // generate keys using first document
    const allKeys = [] as string[]
    for (const doc of docs) {
      allKeys.push(...Object.keys(doc))
    }
    const keys = [] as string[]
    for (const key of allKeys) {
      // eslint-disable-next-line no-continue
      if (keys.indexOf(key) !== -1) continue
      keys.push(key)
    }
    const keyString = keys.map(k => `"${k}"`).join(',')
    const allValues = [] as string[]
    for (const doc of docs) {
      const values = keys
        .map(k => {
          const rowDef = table.rows[k]
          if (!rowDef)
            throw new Error(`Unable to find row definition for key: "${k}"`)
          const val = doc[k]
          if (rowDef.type === 'Bool' && typeof val === 'boolean') {
            return val ? 'true' : 'false'
          }
          if (rowDef.type === 'String' && typeof val === 'string') {
            return `"${escapeQuotes(val)}"`
          }
          if (rowDef.type === 'Int' && typeof val === 'number') {
            return val
          }
          if (rowDef.type === 'Object' && typeof val === 'object') {
            return `"${escapeQuotes(JSON.stringify(val))}"`
          }
          return 'NULL'
        })
        .join(',')
      allValues.push(`(${values})`)
    }
    const sql = `INSERT INTO "${collection}" (${keyString}) VALUES ${allValues.join(
      ', ',
    )};`
    const { changes } = await this.db.run(sql)
    return changes || 0
  }

  async findOne(collection: string, options: FindOneOptions) {
    const [obj] = await this.findMany(collection, {
      ...options,
      limit: 1,
    })
    return obj
  }

  // load related models
  async loadIncluded(
    collection: string,
    options: { models: any[]; include?: any },
  ) {
    const { models, include } = options
    if (!include) return
    const table = this.schema[collection]
    if (!table) throw new Error(`Unable to find table ${collection} in schema`)
    for (const key of Object.keys(include)) {
      // for each relation to include
      const relation = table.relations[key]
      if (!relation)
        throw new Error(`Unable to find relation ${key} in ${collection}`)
      if (include[key]) {
        await this.loadIncludedModels(
          models,
          relation,
          typeof include[key] === 'object' ? include[key] : undefined,
        )
      }
    }
  }

  // load and assign submodels, mutates the models array supplied
  private async loadIncludedModels(
    models: any[],
    relation: Relation & { name: string },
    include?: any,
  ) {
    const values = models.map(model => model[relation.localField])
    // load relevant submodels
    const submodels = await this.findMany(relation.foreignTable, {
      where: {
        [relation.foreignField]: values,
      },
      include: include as any, // load subrelations if needed
    })
    // key the submodels by their relation field
    const keyedSubmodels = {}
    for (const submodel of submodels) {
      // assign to the models
      keyedSubmodels[submodel[relation.foreignField]] = submodel
    }
    // Assign submodel onto model
    for (const model of models) {
      const submodel = keyedSubmodels[model[relation.localField]]
      Object.assign(model, {
        [relation.name]: submodel,
      })
    }
  }

  async findMany(collection: string, options: FindManyOptions) {
    const { where, include } = options
    const orderBy =
      options.orderBy && Object.keys(options.orderBy).length > 0
        ? ` ORDER BY ${Object.keys(options.orderBy)
            .map(key => {
              const val = (options.orderBy || {})[key]
              return `"${key}" ${val.toUpperCase()}`
            })
            .join(', ')}`
        : ''
    const limit = options.limit ? ` LIMIT ${options.limit} ` : ''
    const sql = `SELECT * FROM "${collection}" ${this.whereToSql(
      collection,
      where,
    )} ${orderBy} ${limit};`
    const models = await this.db.all(sql)
    const table = this.schema[collection]
    if (!table) throw new Error(`Unable to find table ${collection}`)
    const objectKeys = Object.keys(table.rows).filter(key => {
      return table.rows[key]?.type === 'Object'
    })
    if (objectKeys.length > 0) {
      // need to expand json objects
      // nested yuck!
      // TODO handle json parse errors
      for (const model of models) {
        for (const key of objectKeys) {
          // eslint-disable-next-line no-continue
          if (typeof model[key] !== 'string') continue
          Object.assign(model, {
            [key]: JSON.parse(model[key]),
          })
        }
      }
    }
    await this.loadIncluded(collection, {
      models,
      include,
    })
    return models
  }

  async count(collection: string, where: WhereClause) {
    const sql = `SELECT COUNT(*) FROM "${collection}" ${this.whereToSql(
      collection,
      where,
    )};`
    const result = await this.db.get(sql)
    return result['COUNT(*)']
  }

  async update(collection: string, options: UpdateOptions) {
    const { where, update } = options
    if (Object.keys(update).length === 0) return 0
    const table = this.schema[collection]
    if (!table) throw new Error(`Unable to find table ${collection} in schema`)
    const setSql = Object.keys(update)
      .map(key => {
        const rowDef = table.rows[key]
        if (!rowDef)
          throw new Error(`Unable to find row definition for key: "${key}"`)
        const val = update[key]
        if (rowDef.type === 'String') {
          return `"${key}" = "${escapeQuotes(val)}"`
        }
        if (rowDef.type === 'Int') {
          return `"${key}" = ${val}`
        }
        if (rowDef.type === 'Bool') {
          return `"${key}" = ${val ? 'true' : 'false'}`
        }
        if (rowDef.type === 'Object') {
          return `"${key}" = "${escapeQuotes(JSON.stringify(val))}"`
        }
        throw new Error('Unknown row type')
      })
      .join(', ')
    const sql = `UPDATE "${collection}" SET ${setSql} ${this.whereToSql(
      collection,
      where,
    )}`
    const result = await this.db.run(sql)
    return result.changes || 0
  }

  async upsert(collection: string, options: UpsertOptions) {
    const { where, update, create } = options
    const updated = await this.update(collection, {
      where,
      update,
    })
    if (updated > 0) {
      return {
        updated,
        created: 0,
      }
    }
    await this.create(collection, create)
    return {
      created: 1,
      updated: 0,
    }
  }

  async deleteOne(collection: string, options: FindOneOptions) {
    return this.deleteMany(collection, {
      ...options,
      limit: 1,
    })
  }

  async deleteMany(collection: string, options: DeleteManyOptions) {
    const table = this.schema[collection]
    if (!table) throw new Error(`Unable to find table "${collection}"`)
    const orderBySql =
      options.orderBy && Object.keys(options.orderBy).length > 0
        ? ` ORDER BY ${Object.keys(options.orderBy)
            .map(key => {
              const val = (options.orderBy || {})[key]
              return `"${key}" ${val.toUpperCase()}`
            })
            .join(', ')}`
        : ''
    const limitSql =
      options.limit === undefined ? '' : ` LIMIT ${options.limit} `
    const sql = `DELETE FROM "${collection}" WHERE "${table.primaryKey}" =
    (SELECT "${table.primaryKey}" FROM "${collection}" ${this.whereToSql(
      collection,
      options.where,
    )} ${orderBySql} ${limitSql});`
    const { changes } = await this.db.run(sql)
    return changes || 0
  }

  async close() {
    await this.db.close()
  }

  // TODO
  async ensureIndex(collection: string, name: string, keys: string[]) {
    console.log(this, collection, name, keys)
  }

  async createTables(tableData: TableData[]) {
    this.schema = constructSchema(tableData)
    // run sql queries creating the tables as necessary
    for (const table of tableData) {
      const { name, primaryKey, rows } = table
      const typeMap = {
        String: 'TEXT',
        Int: 'INTEGER',
        Bool: 'BOOLEAN',
        Object: 'TEXT', // serialize via json in connector
      }
      const rowCommands = rows
        .map(row => {
          const fullRow = normalizeRowDef(row)
          // relations are virtual and assigned at load time
          if (fullRow.relation) return
          return `"${fullRow.name}" ${typeMap[fullRow.type]} ${
            fullRow.optional ? '' : 'NOT NULL'
          } ${fullRow.unique ? 'UNIQUE' : ''}`
        })
        .filter(i => !!i)
      // Do i even need this if i'm loading manually????
      const relationCommands = rows
        .map(row => {
          const fullRow = normalizeRowDef(row)
          if (!fullRow.relation) return
          return `FOREIGN KEY ("${fullRow.relation.localField}")
          REFERENCES "${fullRow.relation.foreignTable}" ("${fullRow.relation.foreignField}")
            ON DELETE SET NULL
            ON UPDATE NO ACTION`
        })
        .filter(i => !!i)
      if (primaryKey) {
        const primaryKeys = [primaryKey]
          .flat()
          .map((name: string) => `"${name}"`)
          .join(',')
        relationCommands.push(`PRIMARY KEY (${primaryKeys})`)
      }
      // assume there's always at least 1 entry in rowCommands and relationCommands
      const sql = `CREATE TABLE IF NOT EXISTS ${name} (
        ${[rowCommands.join(','), relationCommands.join(',')]
          .filter(i => !!i)
          .join(',')}
      );`
      await this.db.exec(sql)
    }
  }
}
