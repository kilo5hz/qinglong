import { Service, Inject } from 'typedi';
import winston from 'winston';
import { createRandomString } from '../config/util';
import config from '../config';
import DataStore from 'nedb';
import { App, AppModel } from '../data/open';
import { v4 as uuidV4 } from 'uuid';
import sequelize, { Op } from 'sequelize';

@Service()
export default class OpenService {
  constructor(@Inject('logger') private logger: winston.Logger) {}

  public async findTokenByValue(token: string): Promise<App | null> {
    const doc = await AppModel.findOne({
      where: sequelize.fn(
        'JSON_CONTAINS',
        sequelize.col('tokens'),
        JSON.stringify({ value: token }),
      ),
    });
    return doc;
  }

  public async create(payload: App): Promise<App> {
    const tab = new App({ ...payload });
    tab.client_id = createRandomString(12, 12);
    tab.client_secret = createRandomString(24, 24);
    const docs = await this.insert([tab]);
    return { ...docs[0], tokens: [] };
  }

  public async insert(payloads: App[]): Promise<App[]> {
    const docs = await AppModel.bulkCreate(payloads);
    return docs;
  }

  public async update(payload: App): Promise<App> {
    const { id, client_id, client_secret, tokens, ...other } = payload;
    const doc = await this.get(id);
    const tab = new App({ ...doc, ...other });
    const newDoc = await this.updateDb(tab);
    return { ...newDoc, tokens: [] };
  }

  private async updateDb(payload: App): Promise<App> {
    const [, docs] = await AppModel.update(
      { ...payload },
      { where: { id: payload.id } },
    );
    return docs[0];
  }

  public async remove(ids: number[]) {
    await AppModel.destroy({ where: { id: ids } });
  }

  public async resetSecret(id: number): Promise<App> {
    const doc = await this.get(id);
    const tab = new App({ ...doc });
    tab.client_secret = createRandomString(24, 24);
    tab.tokens = [];
    const newDoc = await this.updateDb(tab);
    return newDoc;
  }

  public async list(
    searchText: string = '',
    sort: any = {},
    query: any = {},
  ): Promise<App[]> {
    let condition = { ...query };
    if (searchText) {
      const encodeText = encodeURIComponent(searchText);
      const reg = {
        [Op.or]: [
          { [Op.like]: `%${searchText}&` },
          { [Op.like]: `%${encodeText}%` },
        ],
      };

      condition = {
        ...condition,
        [Op.or]: [
          {
            name: reg,
          },
          {
            command: reg,
          },
          {
            schedule: reg,
          },
        ],
      };
    }
    try {
      const result = await this.find(condition);
      return result.map((x) => ({ ...x, tokens: [] }));
    } catch (error) {
      throw error;
    }
  }

  private async find(query: any, sort?: any): Promise<App[]> {
    const docs = await AppModel.findAll({ where: { ...query } });
    return docs;
  }

  public async get(id: number): Promise<App> {
    const docs = await AppModel.findAll({ where: { id } });
    return docs[0];
  }

  public async authToken({
    client_id,
    client_secret,
  }: {
    client_id: string;
    client_secret: string;
  }): Promise<any> {
    const token = uuidV4();
    const expiration = Math.round(Date.now() / 1000) + 2592000; // 2592000 30天
    const doc = await AppModel.findOne({ where: { client_id, client_secret } });
    if (doc) {
      const [, docs] = await AppModel.update(
        { tokens: [...(doc.tokens || []), { value: token, expiration }] },
        { where: { client_id, client_secret } },
      );
      return {
        code: 200,
        data: {
          token,
          token_type: 'Bearer',
          expiration,
        },
      };
    } else {
      return { code: 400, message: 'client_id或client_seret有误' };
    }
  }
}
