import * as net from "net";
import { IConfig, IReaderConfig } from "./ConfigManager";
import { NotificationManager } from "./NotificationManager";

enum State {
    Disconnected,
    ConnectedNeedUsernamePrompt,
    ConnectedNeedPasswordPrompt,
    ConnectedNeedFirstCmdPrompt,
    ConnectedAndSignedIn,
    WaitingForResponse
}

export class AlienManager {
    private static DefaultHost: string = "localhost";
    private static DefaultPort: number = 20000;
    private static DefaultUser: string = "alien";
    private static DefaultPassword: string = "password";

    private static NotifyPort: number = 20001;

    public constructor(config: IConfig, readerConfig: IReaderConfig) {
        this.config = config;
        this.readerConfig = readerConfig;

        this.client = new net.Socket();
        this.state = State.Disconnected;

        this.client.on("connect", () => this.onConnect());
        this.client.on("data", (buffer: Buffer) => this.onData(buffer));
        this.client.on("error", (error) => this.onError(error));

        this.outputBuffer = [];
        this.successCallback = null;
        this.failureCallback = null;

        this.notifMgr = new NotificationManager(this.config, this.readerConfig);
    }

    private config: IConfig;
    private readerConfig: IReaderConfig;
    private notifMgr: NotificationManager;

    private client: net.Socket;
    private state: State;

    private outputBuffer: string[];
    private successCallback: null | ((value: any) => void);
    private failureCallback: null | ((error: Error) => void);

    private responseBuffer: string = "";

    private server: net.Server;
    private notificationCounter: number = 0;

    private onConnect(): void {
        this.state = State.ConnectedNeedUsernamePrompt;
    }

    private onData(buffer: Buffer): void {
        this.responseBuffer += buffer.toString();

        switch (this.state) {
            case State.ConnectedNeedUsernamePrompt:
                if (this.responseBuffer.includes("Username>")) {
                    this.state = State.ConnectedNeedPasswordPrompt;
                    this.responseBuffer = "";
                    this.client.write((this.readerConfig.username || AlienManager.DefaultUser) + "\n");
                }
                break;

            case State.ConnectedNeedPasswordPrompt:
                if (this.responseBuffer.includes("Password>")) {
                    this.state = State.ConnectedNeedFirstCmdPrompt;
                    this.responseBuffer = "";
                    this.client.write((this.readerConfig.password || AlienManager.DefaultPassword) + "\n");
                }
                break;

            case State.ConnectedNeedFirstCmdPrompt:
                if (this.responseBuffer.includes("Alien>")) {
                    this.responseBuffer = "";
                    this.onCommandComplete();
                }
                break;

            case State.ConnectedAndSignedIn:
                this.addToBuffer(this.responseBuffer);
                this.responseBuffer = "";
                break;

            case State.WaitingForResponse:
                if (this.responseBuffer.includes("Alien>")) {
                    this.addToBuffer(this.responseBuffer);
                    this.responseBuffer = "";
                    this.onCommandComplete();
                }
                break;
        }
    }

    private onError(error: Error): void {
        console.error(`error: ${error.name} / ${error.message}`);
        if (this.failureCallback !== null) {
            this.failureCallback(error);
            this.failureCallback = null;
        }
    }

    private addToBuffer(data: string): void {
        const pattern: RegExp = /\r/g;
        const lines: string[] = data.replace(pattern, "").split("\n");
        for (const line of lines) {
            this.outputBuffer.push(line);
        }
    }

    private onCommandComplete(): void {
        this.state = State.ConnectedAndSignedIn;
        var output: string[] = this.outputBuffer.slice(1, this.outputBuffer.length - 2);

        if (this.successCallback !== null) {
            // only return the actual output from the command
            this.successCallback(output);
            this.successCallback = null;
        }
    }

    private async ConnectAndSignIn(): Promise<void> {
        if (this.state !== State.Disconnected) {
            throw "AlienManager: already connected";
        }

        return new Promise<void>((resolve, reject) => {
            this.successCallback = resolve;
            this.failureCallback = reject;

            // this starts the process that will take us through connection
            // and sign-in, and eventually call one of the callbacks.
            this.client.connect(
                this.readerConfig.port || AlienManager.DefaultPort,
                this.readerConfig.address || AlienManager.DefaultHost);
        });
    }

    private async RunCommand(cmd: string): Promise<void> {
        if (this.state !== State.ConnectedAndSignedIn) {
            throw "AlienManager: must be connected to call RunCommand";
        }

        return new Promise<void>((resolve, reject) => {
            this.successCallback = resolve;
            this.failureCallback = reject;

            this.outputBuffer = [];
            this.state = State.WaitingForResponse;
            this.client.write(cmd + "\r\n");
        });
    }

    private setupCmds: string[] = [
        "AcquireMode=Inventory",
        "TagListAntennaCombine=off",
        "NotifyMode=on",
        "NotifyTrigger=TrueFalse",
        "TagListCustomFormat=${TIME2},%N,%A,%k,%m",
        "NotifyFormat=Custom",
        "AutoModeReset",
        "AutoStopTimer=500",
        "AutoAction=Acquire",
        "AutoStartTrigger=0 0",
        "AutoStartPause=0",
        "AutoMode=on"       // should be last
    ];

    private async RunSetup(): Promise<void> {
        let output: any;

        try {
            console.warn("Initializing reader...");
            await this.ConnectAndSignIn();
            // send the variable commands
            output = await this.RunCommand(`ReaderName=${this.readerConfig.name}`);
            output = await this.RunCommand(`AntennaSequence=${this.readerConfig.antennas.join(" ")}`);
            output = await this.RunCommand(`NotifyAddress=${this.client.localAddress}:${AlienManager.NotifyPort}`);

            // send the fixed commands
            for (const command of this.setupCmds) {
                output = await this.RunCommand(command);
            }

            console.warn("Initialization complete!");
        } catch (error) {
            console.error("Setup error");
            throw error;
        }
    }

    public async StartReader(): Promise<void> {
        await this.RunSetup();

        this.server = net.createServer((socket: net.Socket) => {
            socket.on("connect", () => console.warn("Reader connected"));
            socket.on("end", () => console.warn("Reader disconnected"));
            socket.on("error", (error:Error) => {
                console.error(`Incoming connection error: ${error.name}/'${error.message}'`);
            });

            socket.on("data", (data: Buffer) => {
                this.notificationCounter++;
                if ((this.notificationCounter % 10) === 0) { process.stdout.write("."); }
                if ((this.notificationCounter % 800) === 0) { process.stdout.write(".\r\n"); }

                const notification: string = data.toString();

                const pattern: RegExp = /\r/g;
                const lines: string[] = notification.replace(pattern, "").split("\n");
                let notifications: string[] = [];
                for (const line of lines) {
                    if (!line.startsWith("#") &&
                        !line.includes("#Alien") &&
                        !line.includes("No Tags") &&
                        line.length > 3) {
                        // queue the notification for processing
                        notifications.push(line);
                        console.warn(line);
                    }
                }

                // the notifications list may be empty. we still need to call the notification
                // manager so it can process any pending timeouts.
                this.notifMgr.processNotifications(notifications);
            });
        });

        this.server.on("error", (error: Error) => {
            console.error(`Notification server error: ${error.name}/'${error.message}'`);
        });

        this.server.listen(AlienManager.NotifyPort, () => console.warn("Notification server listening..."));
    }

    public StopReader():void {
        this.server.close();
        this.client.destroy();
    }
}
