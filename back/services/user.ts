import { Service, Inject } from 'typedi';
import winston from 'winston';
import { createRandomString, getNetIp, getPlatform } from '../config/util';
import config from '../config';
import * as fs from 'fs';
import _ from 'lodash';
import jwt from 'jsonwebtoken';
import { authenticator } from '@otplib/preset-default';
import { AuthDataType, AuthInfo, AuthModel, LoginStatus } from '../data/auth';
import { NotificationInfo } from '../data/notify';
import NotificationService from './notify';
import { Request } from 'express';
import ScheduleService from './schedule';
import { spawn } from 'child_process';
import SockService from './sock';
import got from 'got';

@Service()
export default class UserService {
  @Inject((type) => NotificationService)
  private notificationService!: NotificationService;

  constructor(
    @Inject('logger') private logger: winston.Logger,
    private scheduleService: ScheduleService,
    private sockService: SockService,
  ) {}

  public async login(
    payloads: {
      username: string;
      password: string;
    },
    req: Request,
    needTwoFactor = true,
  ): Promise<any> {
    if (!fs.existsSync(config.authConfigFile)) {
      return this.initAuthInfo();
    }

    let { username, password } = payloads;
    const content = this.getAuthInfo();
    const timestamp = Date.now();
    if (content) {
      let {
        username: cUsername,
        password: cPassword,
        retries = 0,
        lastlogon,
        lastip,
        lastaddr,
        twoFactorActivated,
        twoFactorActived,
        tokens = {},
        platform,
      } = content;
      // patch old field
      twoFactorActivated = twoFactorActivated || twoFactorActived;

      if (
        (cUsername === 'admin' && cPassword === 'admin') ||
        !cUsername ||
        !cPassword
      ) {
        return this.initAuthInfo();
      }

      if (retries > 2 && Date.now() - lastlogon < Math.pow(3, retries) * 1000) {
        return {
          code: 410,
          message: `失败次数过多，请${Math.round(
            (Math.pow(3, retries) * 1000 - Date.now() + lastlogon) / 1000,
          )}秒后重试`,
          data: Math.round(
            (Math.pow(3, retries) * 1000 - Date.now() + lastlogon) / 1000,
          ),
        };
      }

      const { ip, address } = await getNetIp(req);
      if (username === cUsername && password === cPassword) {
        if (twoFactorActivated && needTwoFactor) {
          this.updateAuthInfo(content, {
            isTwoFactorChecking: true,
          });
          return {
            code: 420,
            message: '请输入两步验证token',
          };
        }

        const data = createRandomString(50, 100);
        const expiration = twoFactorActivated ? 30 : 3;
        let token = jwt.sign({ data }, config.secret as any, {
          expiresIn: 60 * 60 * 24 * expiration,
          algorithm: 'HS384',
        });

        this.updateAuthInfo(content, {
          token,
          tokens: {
            ...tokens,
            [req.platform]: token,
          },
          lastlogon: timestamp,
          retries: 0,
          lastip: ip,
          lastaddr: address,
          platform: req.platform,
          isTwoFactorChecking: false,
        });
        await this.notificationService.notify(
          '登录通知',
          `你于${new Date(timestamp).toLocaleString()}在 ${address} ${
            req.platform
          }端 登录成功，ip地址 ${ip}`,
        );
        await this.getLoginLog();
        await this.insertDb({
          type: AuthDataType.loginLog,
          info: {
            timestamp,
            address,
            ip,
            platform: req.platform,
            status: LoginStatus.success,
          },
        });
        return {
          code: 200,
          data: { token, lastip, lastaddr, lastlogon, retries, platform },
        };
      } else {
        this.updateAuthInfo(content, {
          retries: retries + 1,
          lastlogon: timestamp,
          lastip: ip,
          lastaddr: address,
          platform: req.platform,
        });
        await this.notificationService.notify(
          '登录通知',
          `你于${new Date(timestamp).toLocaleString()}在 ${address} ${
            req.platform
          }端 登录失败，ip地址 ${ip}`,
        );
        await this.getLoginLog();
        await this.insertDb({
          type: AuthDataType.loginLog,
          info: {
            timestamp,
            address,
            ip,
            platform: req.platform,
            status: LoginStatus.fail,
          },
        });
        return { code: 400, message: config.authError };
      }
    } else {
      return this.initAuthInfo();
    }
  }

  public async logout(platform: string): Promise<any> {
    const authInfo = this.getAuthInfo();
    this.updateAuthInfo(authInfo, {
      token: '',
      tokens: { ...authInfo.tokens, [platform]: '' },
    });
  }

  public async getLoginLog(): Promise<AuthInfo[]> {
    const docs = await AuthModel.findAll({
      where: { type: AuthDataType.loginLog },
    });
    if (docs && docs.length > 0) {
      const result = docs.sort((a, b) => b.info.timestamp - a.info.timestamp);
      if (result.length > 100) {
        await AuthModel.destroy({
          where: { id: result[result.length - 1].id },
        });
      }
      return result.map((x) => x.info);
    }
    return [];
  }

  private async insertDb(payload: AuthInfo): Promise<AuthInfo> {
    const doc = await AuthModel.create({ ...payload }, { returning: true });
    return doc;
  }

  private initAuthInfo() {
    const newPassword = createRandomString(16, 22);
    fs.writeFileSync(
      config.authConfigFile,
      JSON.stringify({
        username: 'admin',
        password: newPassword,
      }),
    );
    return {
      code: 100,
      message: '已初始化密码，请前往auth.json查看并重新登录',
    };
  }

  public async updateUsernameAndPassword({
    username,
    password,
  }: {
    username: string;
    password: string;
  }) {
    if (password === 'admin') {
      return { code: 400, message: '密码不能设置为admin' };
    }
    const authInfo = this.getAuthInfo();
    this.updateAuthInfo(authInfo, { username, password });
    return { code: 200, message: '更新成功' };
  }

  public getUserInfo(): Promise<any> {
    return new Promise((resolve) => {
      fs.readFile(config.authConfigFile, 'utf8', (err, data) => {
        if (err) console.log(err);
        resolve(JSON.parse(data));
      });
    });
  }

  public initTwoFactor() {
    const secret = authenticator.generateSecret();
    const authInfo = this.getAuthInfo();
    const otpauth = authenticator.keyuri(authInfo.username, 'qinglong', secret);
    this.updateAuthInfo(authInfo, { twoFactorSecret: secret });
    return { secret, url: otpauth };
  }

  public activeTwoFactor(code: string) {
    const authInfo = this.getAuthInfo();
    const isValid = authenticator.verify({
      token: code,
      secret: authInfo.twoFactorSecret,
    });
    if (isValid) {
      this.updateAuthInfo(authInfo, { twoFactorActivated: true });
    }
    return isValid;
  }

  public async twoFactorLogin(
    {
      username,
      password,
      code,
    }: { username: string; password: string; code: string },
    req: any,
  ) {
    const authInfo = this.getAuthInfo();
    const { isTwoFactorChecking, twoFactorSecret } = authInfo;
    if (!isTwoFactorChecking) {
      return { code: 450, message: '未知错误' };
    }
    const isValid = authenticator.verify({
      token: code,
      secret: twoFactorSecret,
    });
    if (isValid) {
      return this.login({ username, password }, req, false);
    } else {
      const { ip, address } = await getNetIp(req);
      this.updateAuthInfo(authInfo, {
        lastip: ip,
        lastaddr: address,
        platform: req.platform,
      });
      return { code: 430, message: '验证失败' };
    }
  }

  public deactiveTwoFactor() {
    const authInfo = this.getAuthInfo();
    this.updateAuthInfo(authInfo, {
      twoFactorActivated: false,
      twoFactorActived: false,
      twoFactorSecret: '',
    });
    return true;
  }

  private getAuthInfo() {
    const content = fs.readFileSync(config.authConfigFile, 'utf8');
    return JSON.parse(content || '{}');
  }

  private updateAuthInfo(authInfo: any, info: any) {
    fs.writeFileSync(
      config.authConfigFile,
      JSON.stringify({ ...authInfo, ...info }),
    );
  }

  public async getNotificationMode(): Promise<NotificationInfo> {
    const doc = await AuthModel.findOne({
      where: { type: AuthDataType.notification },
    });
    return (doc && doc.info) || {};
  }

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
