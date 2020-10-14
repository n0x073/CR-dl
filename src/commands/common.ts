import got from "../requester/got";
import curl from "../requester/curl";
import * as request from "request";
import * as fs from "fs";
import { Requester, RequesterCdn } from "../types/Requester";

const cookies = request.jar();


interface ToughCookie {
    key: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    expires?: string;
    httpOnly: boolean;
    hostOnly: boolean;
    lastAccess: string;
    creation: string;
}

export function loadCookies(options: { cookies: string }): void {

}

export function saveCookies(options: { cookies: string }, createFile?: boolean): void {

}

export function getRequester(options: { cookies: string, proxy?: string }): Requester {
    return curl(options.cookies, options.proxy);
}

export function getRequesterCdn(options: { proxyCdn?: string }): RequesterCdn {
    return got(options.proxyCdn);
}
