#!/usr/bin/env node
import { start, stop, chat, send, sync, holodeckCreate, holodeckChat, holodeckTeardown, holodeckPromote, startSupervisor, stopSupervisor, resolveRoot, } from './service.js';
const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
    case 'start':
        start(args[0]).catch((err) => { console.error(err.message); process.exit(1); });
        break;
    case 'stop':
        stop(args[0]).catch((err) => { console.error(err.message); process.exit(1); });
        break;
    case 'chat':
        if (!args[0]) {
            console.error('Usage: cli chat <bot>');
            process.exit(1);
        }
        chat(args[0]);
        break;
    case 'send':
        if (args.length < 2) {
            console.error('Usage: cli send <room> <message>');
            process.exit(1);
        }
        send(args[0], args.slice(1).join(' ')).catch((err) => {
            console.error(err.message);
            process.exit(1);
        });
        break;
    case 'sync': {
        const direction = args[0];
        if (direction !== 'push' && direction !== 'pull') {
            console.error('Usage: cli sync push|pull');
            process.exit(1);
        }
        sync(direction).catch((err) => {
            console.error(err.message);
            process.exit(1);
        });
        break;
    }
    case 'holodeck': {
        const [sub, ...hArgs] = args;
        switch (sub) {
            case 'create':
                if (hArgs.length < 2) {
                    console.error('Usage: cli holodeck create <bot> <branch>');
                    process.exit(1);
                }
                holodeckCreate(hArgs[0], hArgs[1]);
                break;
            case 'chat':
                if (!hArgs[0]) {
                    console.error('Usage: cli holodeck chat <bot>');
                    process.exit(1);
                }
                holodeckChat(hArgs[0]);
                break;
            case 'teardown':
                if (!hArgs[0]) {
                    console.error('Usage: cli holodeck teardown <bot>');
                    process.exit(1);
                }
                holodeckTeardown(hArgs[0]);
                break;
            case 'promote':
                if (!hArgs[0]) {
                    console.error('Usage: cli holodeck promote <bot>');
                    process.exit(1);
                }
                holodeckPromote(hArgs[0]);
                break;
            default:
                console.error('Usage: cli holodeck create|chat|teardown|promote');
                process.exit(1);
        }
        break;
    }
    case 'supervisor': {
        const sub = args[0];
        if (sub === 'start') {
            startSupervisor(resolveRoot());
        }
        else if (sub === 'stop') {
            stopSupervisor();
        }
        else {
            console.error('Usage: cli supervisor start|stop');
            process.exit(1);
        }
        break;
    }
    default:
        console.error('Usage: cli start|stop|chat|send|sync|holodeck|supervisor');
        process.exit(1);
}
//# sourceMappingURL=cli.js.map