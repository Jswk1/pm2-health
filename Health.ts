import * as PM2 from "pm2";
import * as Pmx from "pmx";
import * as Fs from "fs";
import { basename } from "path";
import { Mail, ISmtpConfig } from "./Mail";
import { Snapshot, IShapshotConfig, IAuth } from "./Snapshot";
import { Fetch } from "planck-http-fetch";
import { info, error, debug, enableDebugLog } from "./Log";

const
    MERTIC_INTERVAL_S = 60,
    HOLD_PERIOD_M = 30,
    ALIVE_MAX_CONSECUTIVE_TESTS = 6,
    ALIVE_CONSECUTIVE_TIMEOUT_S = 600,
    LOGS = ["pm_err_log_path", "pm_out_log_path"],
    OP = {
        "<": (a, b, t) => a < b && Math.abs(a - b) > t,
        ">": (a, b, t) => a > b && Math.abs(a - b) > t,
        "=": (a, b, t) => a === b,
        "~": (a, b, t) => Math.abs(a - b) > t,
        "<=": (a, b, t) => a <= b,
        ">=": (a, b, t) => a >= b,
        "!=": (a, b, t) => a !== b,
        "!~": (a, b, t) => Math.abs(a - b) > t
    },
    CONFIG_KEYS = ["events", "metric", "exceptions", "messages", "messageExcludeExps", "appsExcluded", "metricIntervalS", "addLogs", "aliveTimeoutS"];

interface IMonitConfig {
    events: string[];
    metric: {
        [key: string]: {
            target?: any;
            op?: "<" | ">" | "=" | "<=" | ">=" | "!=";
            ifChanged?: boolean;
            noHistory?: boolean;
            noNotify: boolean;
            exclude?: boolean;
            direct?: boolean;
            tolerance?: number;
        }
    },
    exceptions: boolean;
    messages: boolean;
    messageExcludeExps: string;
    appsIncluded: string[];
    appsExcluded: string[];
    metricIntervalS: number;
    addLogs: boolean;
    aliveTimeoutS: number;
}

interface IConfig extends IMonitConfig, ISmtpConfig, IShapshotConfig {
    webConfig: {
        url: string;
        auth?: IAuth;
        fetchIntervalM: number;
    },
    debugLogEnabled?: boolean;
}

export class Health {
    readonly _mail: Mail;
    readonly _snapshot: Snapshot;
    _holdTill: Date = null;

    constructor(private _config: IConfig) {
        if (this._config.debugLogEnabled === true)
            enableDebugLog();

        if (this._config.metricIntervalS == null || this._config.metricIntervalS < MERTIC_INTERVAL_S) {
            info(`setting default metric check interval ${MERTIC_INTERVAL_S} s.`);
            this._config.metricIntervalS = MERTIC_INTERVAL_S;
        }

        if (!this._config.metric)
            this._config.metric = {};

        this._mail = new Mail(_config);
        this._snapshot = new Snapshot(this._config);
    }

    async fetchConfig() {
        try {
            info(`fetching config from [${this._config.webConfig.url}]`);

            const fetch = new Fetch(this._config.webConfig.url);
            if (this._config.webConfig.auth && this._config.webConfig.auth.user)  // auth
                fetch.basicAuth(this._config.webConfig.auth.user, this._config.webConfig.auth.password);
            const
                json = await fetch.fetch(),
                config = JSON.parse(json);

            // map config keys
            for (const key of CONFIG_KEYS)
                if (config[key]) {
                    this._config[key] = config[key];
                    info(`applying [${key}]`);
                }

            this.configChanged();
        }
        catch (ex) {
            error(`failed to fetch config -> ${ex.message || ex}`);
        }
    }

    _messageExcludeExps: RegExp[];

    configChanged() {
        this._messageExcludeExps = [];
        if (Array.isArray(this._config.messageExcludeExps))
            this._messageExcludeExps = this._config.messageExcludeExps.map(e => new RegExp(e));
    }

    isAppIncluded(app: string) {
        if (app === "pm2-health")
            return false;

        if (Array.isArray(this._config.appsIncluded))
            return this._config.appsIncluded.includes(app);

        if (Array.isArray(this._config.appsExcluded))
            return !this._config.appsExcluded.includes(app);

        return false;
    }

    async go() {
        info(`pm2-health is on`);

        this.configChanged();

        // fetch web config (if set)
        if (this._config.webConfig && this._config.webConfig.url) {
            await this.fetchConfig();

            if (this._config.webConfig.fetchIntervalM > 0)
                setInterval(
                    () => {
                        this.fetchConfig();
                    },
                    this._config.webConfig.fetchIntervalM * 60 * 1000);
        }

        PM2.connect((ex) => {
            stopIfEx(ex);

            PM2.launchBus((ex, bus) => {
                stopIfEx(ex);

                bus.on("process:event", (data) => {
                    if (data.manually || !this.isAppIncluded(data.process.name))
                        return;

                    if (Array.isArray(this._config.events) && this._config.events.indexOf(data.event) === -1)
                        return;

                    this.mail(
                        `${data.process.name}:${data.process.pm_id} - ${data.event}`,
                        `
                        <p>App: <b>${data.process.name}:${data.process.pm_id}</b></p>
                        <p>Event: <b>${data.event}</b></p>
                        <pre>${JSON.stringify(data, undefined, 4)}</pre>`,
                        "high",
                        LOGS.filter(e => this._config.addLogs === true && data.process[e]).map(e => ({ filename: basename(data.process[e]), path: data.process[e] })));
                });

                if (this._config.exceptions)
                    bus.on("process:exception", (data) => {
                        if (!this.isAppIncluded(data.process.name))
                            return;

                        this.mail(
                            `${data.process.name}:${data.process.pm_id} - exception`,
                            `
                            <p>App: <b>${data.process.name}:${data.process.pm_id}</b></p>                            
                            <pre>${JSON.stringify(data.data, undefined, 4)}</pre>`,
                            "high");
                    });

                if (this._config.messages)
                    bus.on("process:msg", (data) => {
                        if (!this.isAppIncluded(data.process.name))
                            return;

                        if (data.data === "alive") {
                            this.aliveReset(data.process, this._config.aliveTimeoutS);
                            return;
                        }

                        const json = JSON.stringify(data.data, undefined, 4);

                        if (this._messageExcludeExps.some(e => e.test(json)))
                            return; // exclude

                        this.mail(
                            `${data.process.name}:${data.process.pm_id} - message`,
                            `
                            <p>App: <b>${data.process.name}:${data.process.pm_id}</b></p>
                            <pre>${json}</pre>`);
                    });
            });

            this.testProbes();
        });

        Pmx.action("hold", undefined, (p, reply) => {
            let t = HOLD_PERIOD_M;
            if (p) {
                const n = Number.parseInt(p);
                if (!Number.isNaN(n))
                    t = n;
            }

            this._holdTill = new Date();
            this._holdTill.setTime(this._holdTill.getTime() + t * 60000);

            const msg = `mail held for ${t} minutes, till ${this._holdTill.toISOString()}`;
            info(msg);
            reply(msg);
        });

        Pmx.action("unheld", undefined, (reply) => {
            this._holdTill = null;
            info("mail unheld");
            reply("mail unheld");
        });

        Pmx.action("mail", undefined, async (reply) => {
            try {
                await this._mail.send("Test only", "This is test only.");
                info("mail send");
                reply("mail send");
            }
            catch (ex) {
                reply(`mail failed: ${ex.message || ex}`);
            }
        });

        Pmx.action("dump", undefined, (reply) => {
            this._snapshot.dump();
            reply(`dumping`);
        });

        // for dev. only
        Pmx.action("debug", undefined, (reply) => {
            PM2.list((ex, list) => {
                stopIfEx(ex);

                Fs.writeFileSync("pm2-health-debug.json", JSON.stringify(list));
                Fs.writeFileSync("pm2-health-config.json", JSON.stringify(this._config));

                reply(`dumping`);
            });
        });
    }

    private _timeouts = new Map<string, NodeJS.Timer>();

    private aliveReset(process: { name, pm_id }, timeoutS: number, count = 1) {
        clearTimeout(this._timeouts.get(process.name));

        this._timeouts.set(
            process.name,
            setTimeout(() => {
                info(`death ${process.name}:${process.pm_id}, count ${count}`);

                this.mail(
                    `${process.name}:${process.pm_id} - is death!`,
                    `
                    <p>App: <b>${process.name}:${process.pm_id}</b></p>
                    <p>This is <b>${count}/${ALIVE_MAX_CONSECUTIVE_TESTS}</b> consecutive notice.</p>`,
                    "high");

                if (count < ALIVE_MAX_CONSECUTIVE_TESTS)
                    this.aliveReset(process, ALIVE_CONSECUTIVE_TIMEOUT_S, count + 1);
            }, timeoutS * 1000));
    }

    private async mail(subject: string, body: string, priority?: "high" | "low", attachements = []) {
        const t = new Date();
        if (this._holdTill != null && t < this._holdTill)
            return; // skip

        try {
            await this._mail.send(subject, body, priority, attachements);
            info(`mail [${subject}] sent`);
        }
        catch (ex) {
            error(`mail failed -> ${ex.message || ex}`);
        }
    }

    private testProbes() {
        debug("testing probes");

        const alerts = [];

        PM2.list(async (ex, list) => {
            stopIfEx(ex);

            for (const app of list) {
                if (!this.isAppIncluded(app.name))
                    continue;

                let monit = app.pm2_env["axm_monitor"];
                if (!monit)
                    monit = {};

                // add memory + cpu metrics
                if (app.monit) {
                    monit["memory"] = { value: app.monit.memory / 1048576 };
                    monit["cpu"] = { value: app.monit.cpu };
                }

                if (app.pm2_env) {
                    if (app.pm2_env["_pm2_version"])
                        monit["pm2"] = { value: app.pm2_env["_pm2_version"], direct: true };

                    if (app.pm2_env["node_version"])
                        monit["node"] = { value: app.pm2_env["node_version"], direct: true };
                }

                for (const key of Object.keys(monit)) {
                    let probe = this._config.metric[key];
                    if (!probe)
                        probe = { noNotify: true, direct: monit[key].direct === true, noHistory: monit[key].direct === true };

                    if (probe.exclude === true)
                        continue;

                    let
                        v = monit[key].value,
                        bad: boolean;

                    if (!probe.direct) {
                        v = Number.parseFloat(v);
                        if (Number.isNaN(v)) {
                            error(`monit [${app.name}.${key}] -> [${monit[key].value}] is not a number`);
                            continue;
                        }
                    }

                    if (probe.op && probe.op in OP && probe.target != null)
                        bad = OP[probe.op](v, probe.target, probe.tolerance || 0);

                    // test
                    if (probe.noNotify !== true && bad === true && (probe.ifChanged !== true || this._snapshot.last(app.pm_id, key) !== v))
                        alerts.push(`<tr><td>${app.name}:${app.pm_id}</td><td>${key}</td><td>${v}</td><td>${this._snapshot.last(app.pm_id, key)}</td><td>${probe.target}</td></tr>`);

                    const data: any = { v }
                    if (bad)    // safe space by not storing false
                        data.bad = true;

                    this._snapshot.push(app.pm_id, app.name, key, !probe.noHistory, data);
                }
            }

            this._snapshot.inactivate();
            await this._snapshot.send();

            if (alerts.length > 0)
                this.mail(
                    `${alerts.length} alert(s)`,
                    `
                    <table>
                        <tr>
                            <th>App</th><th>Metric</th><th>Value</th><th>Prev. Value</th><th>Target</th>
                        </tr>
                        ${alerts.join("")}
                    </table>`,
                    "high");

            setTimeout(
                () => { this.testProbes(); },
                1000 * this._config.metricIntervalS);
        });
    }
}

export function stopIfEx(ex: any) {
    if (ex) {
        error(ex.message || ex);
        PM2.disconnect();
        process.exit(1);
    }
}