import * as net from 'net';
import { IReaderConfig } from "./ConfigManager";

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

    public constructor(readerConfig: IReaderConfig) {
        this.readerConfig = readerConfig;

        this.client = new net.Socket();
        this.state = State.Disconnected;

        this.client.on("connect", () => this.onConnect());
        this.client.on("data", (buffer: Buffer) => this.onData(buffer));
        this.client.on("error", (error) => this.onError(error));

        this.outputBuffer = [];
        this.successCallback = null;
        this.failureCallback = null;
    }

    private readerConfig: IReaderConfig;

    private client: net.Socket;
    private state: State;

    private outputBuffer: string[];
    private successCallback: null | ((value: any) => void);
    private failureCallback: null | ((error: Error) => void);

    private onConnect() {
        this.state = State.ConnectedNeedUsernamePrompt;
    }

    private incomingBuffer: string = "";

    private onData(buffer: Buffer) {
        this.incomingBuffer += buffer.toString();

        switch (this.state) {
            case State.ConnectedNeedUsernamePrompt:
                if (this.incomingBuffer.includes("Username>")) {
                    this.state = State.ConnectedNeedPasswordPrompt;
                    this.incomingBuffer = "";
                    this.client.write((this.readerConfig.username || AlienManager.DefaultUser) + "\n");
                }
                break;

            case State.ConnectedNeedPasswordPrompt:
                if (this.incomingBuffer.includes("Password>")) {
                    this.state = State.ConnectedNeedFirstCmdPrompt;
                    this.incomingBuffer = "";
                    this.client.write((this.readerConfig.password || AlienManager.DefaultPassword) + "\n");
                }
                break;

            case State.ConnectedNeedFirstCmdPrompt:
                if (this.incomingBuffer.includes("Alien>")) {
                    this.incomingBuffer = "";
                    this.onCommandComplete();
                }
                break;

            case State.ConnectedAndSignedIn:
                this.addToBuffer(this.incomingBuffer);
                this.incomingBuffer = "";
                break;

            case State.WaitingForResponse:
                if (this.incomingBuffer.includes("Alien>")) {
                    this.addToBuffer(this.incomingBuffer);
                    this.incomingBuffer = "";
                    this.onCommandComplete();
                }
                break;
        }
    }

    private addToBuffer(data: string) {
        const pattern = /\r/g;
        const lines: string[] = data.replace(pattern, "").split("\n");
        for (const line of lines) {
            this.outputBuffer.push(line);
        }
    }

    private onError(error: Error) {
        console.error(`error: ${error.name} / ${error.message}`);
        if (this.failureCallback !== null) {
            this.failureCallback(error);
            this.failureCallback = null;
        }
    }

    private onCommandComplete() {
        this.state = State.ConnectedAndSignedIn;
        var output = this.outputBuffer.slice(1, this.outputBuffer.length - 2);

        if (this.successCallback !== null) {
            // only return the actual output from the command
            this.successCallback(output);
            this.successCallback = null;
        }
    }

    public async ConnectAndSignIn(): Promise<void> {
        if (this.state != State.Disconnected) {
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

    public async RunCommand(cmd: string): Promise<void> {
        if (this.state != State.ConnectedAndSignedIn) {
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
        "TagListCustomFormat=%N,%A,%k,%m",
        "NotifyFormat=Custom",
        "AutoModeReset",
        "AutoStopTimer=1000",
        "AutoAction=Acquire",
        "AutoStartTrigger=0 0",
        "AutoStartPause=0",
        "AutoMode=on"       // should be last
    ]

    private async RunSetup(): Promise<void> {
        let output: any;

        try {
            console.warn("Initializing reader...");
            await this.ConnectAndSignIn();
            // Send the variable commands
            output = await this.RunCommand(`ReaderName=${this.readerConfig.name}`);
            output = await this.RunCommand(`AntennaSequence=${this.readerConfig.antennas.join(" ")}`);
            output = await this.RunCommand(`NotifyAddress=${this.client.localAddress}:${AlienManager.NotifyPort}`);

            // Send the fixed commands
            for (const command of this.setupCmds) {
                output = await this.RunCommand(command);
            }

            console.warn("Initialization complete!");
        } catch (error) {
            console.error("Setup error");
            throw error;
        }
    }

    private server: net.Server;

    public async StartServer(): Promise<void> {
        await this.RunSetup();

        this.server = net.createServer((socket: net.Socket) => {
            socket.on('end', () => { console.info("Client disconnected"); });
            socket.on('error', (error:Error) => { console.error("Listener error"); });

            socket.on('data', (data: Buffer) => {
                const notification: string = data.toString();

                const pattern = /\r/g;
                const lines: string[] = notification.replace(pattern, "").split("\n");
                for (const line of lines) {
                    if (!line.startsWith("#") &&
                        !line.includes("#Alien") &&
                        !line.includes("No Tags") &&
                        line.length > 2) {
                        // TODO: process the notification
                        console.info(line);
                    }
                }
            });
        });

        this.server.on('error', (err: Error) => {
            console.error("server error");
        });

        this.server.listen(AlienManager.NotifyPort, () => console.info("Notification server listening..."));
    }

    public StopServer():void {
        this.server.close();
        this.client.destroy();
    }
}
