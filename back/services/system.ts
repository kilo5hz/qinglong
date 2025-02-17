import { Service, Inject } from 'typedi';
import winston from 'winston';
import config from '../config';
import * as fs from 'fs';
import _ from 'lodash';
import { AuthDataType, AuthInfo, AuthModel, LoginStatus } from '../data/auth';
import { NotificationInfo } from '../data/notify';
import NotificationService from './notify';
import ScheduleService from './schedule';
import { spawn } from 'child_process';
import SockService from './sock';
import got from 'got';
import { dbs } from '../loaders/db';

@Service()
export default class SystemService {
  @Inject((type) => NotificationService)
  private notificationService!: NotificationService;

  constructor(
    @Inject('logger') private logger: winston.Logger,
    private scheduleService: ScheduleService,
    private sockService: SockService,
  ) {}

  public async getLogRemoveFrequency() {
    const doc = await AuthModel.findOne({
      where: { type: AuthDataType.removeLogFrequency },
    });
    return (doc && doc.info) || {};
  }

  private async updateAuthDb(payload: AuthInfo): Promise<any> {
    await AuthModel.upsert({ ...payload });
    const doc = await AuthModel.findOne({ where: { type: payload.type } });
    return doc;
  }

  public async updateNotificationMode(notificationInfo: NotificationInfo) {
    const code = Math.random().toString().slice(-6);
    const isSuccess = await this.notificationService.testNotify(
      notificationInfo,
      '青龙',
      `【蛟龙】测试通知 https://t.me/jiao_long`,
    );
    if (isSuccess) {
      const result = await this.updateAuthDb({
        type: AuthDataType.notification,
        info: { ...notificationInfo },
      });
      return { code: 200, data: { ...result, code } };
    } else {
      return { code: 400, data: '通知发送失败，请检查参数' };
    }
  }

  public async updateLogRemoveFrequency(frequency: number) {
    const result = await this.updateAuthDb({
      type: AuthDataType.removeLogFrequency,
      info: { frequency },
    });
    const cron = {
      id: result.id,
      name: '删除日志',
      command: `ql rmlog ${frequency}`,
      schedule: `5 23 */${frequency} * *`,
    };
    await this.scheduleService.cancelSchedule(cron);
    if (frequency > 0) {
      await this.scheduleService.generateSchedule(cron);
    }
    return { code: 200, data: { ...cron } };
  }

  public async checkUpdate() {
    try {
      const versionRegx = /.*export const version = \'(.*)\'\;/;
      const logRegx = /.*export const changeLog = \`((.*\n.*)+)\`;/;

      const currentVersionFile = fs.readFileSync(config.versionFile, 'utf8');
      const currentVersion = currentVersionFile.match(versionRegx)![1];

      let lastVersion = '';
      let lastLog = '';
      try {
        const result = await Promise.race([
          got.get(config.lastVersionFile, { timeout: 1000, retry: 0 }),
          got.get(`https://ghproxy.com/${config.lastVersionFile}`, {
            timeout: 5000,
            retry: 0,
          }),
        ]);
        const lastVersionFileContent = result.body;
        lastVersion = lastVersionFileContent.match(versionRegx)![1];
        lastLog = lastVersionFileContent.match(logRegx)
          ? lastVersionFileContent.match(logRegx)![1]
          : '';
      } catch (error) {}

      return {
        code: 200,
        data: {
          hasNewVersion: this.checkHasNewVersion(currentVersion, lastVersion),
          lastVersion,
          lastLog,
        },
      };
    } catch (error: any) {
      return {
        code: 400,
        data: error.message,
      };
    }
  }

  private checkHasNewVersion(curVersion: string, lastVersion: string) {
    const curArr = curVersion.split('.').map((x) => parseInt(x, 10));
    const lastArr = lastVersion.split('.').map((x) => parseInt(x, 10));
    if (curArr[0] < lastArr[0]) {
      return true;
    }
    if (curArr[0] === lastArr[0] && curArr[1] < lastArr[1]) {
      return true;
    }
    if (
      curArr[0] === lastArr[0] &&
      curArr[1] === lastArr[1] &&
      curArr[2] < lastArr[2]
    ) {
      return true;
    }
    return false;
  }

  public async updateSystem() {
    const cp = spawn('ql -l update', { shell: '/bin/bash' });

    this.sockService.sendMessage({
      type: 'updateSystemVersion',
      message: `开始更新系统`,
    });
    cp.stdout.on('data', (data) => {
      this.sockService.sendMessage({
        type: 'updateSystemVersion',
        message: data.toString(),
      });
    });

    cp.stderr.on('data', (data) => {
      this.sockService.sendMessage({
        type: 'updateSystemVersion',
        message: data.toString(),
      });
    });

    cp.on('error', (err) => {
      this.sockService.sendMessage({
        type: 'updateSystemVersion',
        message: JSON.stringify(err),
      });
    });

    return { code: 200 };
  }
}
