import {ReactiveModule} from "../../src/reactive/reactive_module";
import {ReactiveModuleOptions} from "../../src/reactive/types";

export function createReactiveModule(options?: ReactiveModuleOptions){
    // console.info("process.env.LOGLEVEL =", (globalThis as any).process?.env?.LOGLEVEL);

    const process = (globalThis as any).process || { env: { LOGLEVEL: 'error' } };
    const levels = [ 'trace', 'debug', 'info', 'error'];
    const envLevel = options?.logLevel ||
        (levels.indexOf(process.env.LOGLEVEL) >=0 ? process.env.LOGLEVEL : 'error'); //

    return new ReactiveModule({ logLevel: envLevel, ...options }); // Set logLevel via LOGLEVEL env (default: error)
}