import request from "request";
import { Requester } from "../types/Requester";

const querystring = require('querystring');
const { Curl, CurlSslVersionMax, CurlHttpVersion } = require('node-libcurl');

export default function (cookies: string, proxy?: string): Requester {
    return {
        get: (url: string): Promise<{ body: Buffer; url: string }> => {
            return new Promise((resolve, reject) => {
                const curl = new Curl();
                curl.setOpt('URL', url);
                curl.setOpt('FOLLOWLOCATION', true);
                curl.setOpt(Curl.option.HTTPHEADER, [
                    "User-Agent: Mozilla/5.0 (Windows NT 10.0; WOW64; Trident/7.0; rv:11.0) like Gecko",
                ]);
                curl.setOpt(Curl.option.SSLVERSION, CurlSslVersionMax.TlsV1_1);
                curl.setOpt(Curl.option.COOKIEJAR, cookies);
                curl.setOpt(Curl.option.COOKIEFILE, cookies);
                curl.on('end', function (this: typeof Curl, statusCode: number, data: any, headers: any) {
                    var redirected_url = this.getInfo( 'EFFECTIVE_URL');
                    this.close();                    
                    resolve({ body: data, url: redirected_url as string });
                });
                curl.on('error', function() {
                    curl.close.bind(curl);
                    reject();
                });
                curl.perform();
            });
        },
        post: (url: string, formData?: Record<string, string>): Promise<{ body: Buffer }> => {
            return new Promise((resolve, reject) => {
                const curl = new Curl();
                curl.setOpt('URL', url);
                curl.setOpt('FOLLOWLOCATION', true);
                curl.setOpt(Curl.option.HTTPHEADER, [
                    "User-Agent: Mozilla/5.0 (Windows NT 10.0; WOW64; Trident/7.0; rv:11.0) like Gecko",
                ]);
                curl.setOpt(Curl.option.SSLVERSION, CurlSslVersionMax.TlsV1_1);
                curl.setOpt(Curl.option.COOKIEJAR, "cookies.txt");
                curl.setOpt(Curl.option.COOKIEFILE, "cookies.txt");
                curl.setOpt(Curl.option.POST, true);
                curl.setOpt(Curl.option.POSTFIELDS, querystring.stringify(formData));
                curl.on('end', function (this: typeof Curl, statusCode: number, data: any, headers: any) {
                    this.close();
                    resolve({ body: data });
                });
                curl.on('error', function() {
                    curl.close.bind(curl);
                    reject();
                });
                curl.perform();
            });
        }
    };

}
