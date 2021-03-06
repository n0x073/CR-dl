#!/usr/bin/env node
import { Command } from "commander";
import { loadCookies, getRequester, saveCookies, getRequesterCdn } from "./common";
import { CrDl, Episode } from "../api/CrDl";
import { UserInputError, RuntimeError } from "../Errors";
import { languages, Language } from "../types/language";
import { makeid, pad, toFilename, formatScene, deleteFolderRecursive } from "../Utils";
import * as util from "util";
import * as fs from "fs";
import * as path from "path";
import { SubtitleInfo, StreamInfo } from "../interfaces/video";
import { downloadFontsFromSubtitles } from "../downloader/FontDownloader";
import { Requester, RequesterCdn } from "../types/Requester";
import * as format_ from "string-format";
import { M3uDownloader } from "../downloader/M3uDownloader";
import { ListDownloader, DownloadUpdateOptions } from "../downloader/ListDownloader";
import { VideoMuxer } from "../downloader/VideoMuxer";
import * as cliProgress from "cli-progress";
import prettyBytes from "pretty-bytes";
import { spawn } from "child_process";
const format = format_.create({
    scene: formatScene
});
export const download = new Command();

interface Options {
    proxy?: string;
    proxyCdn?: string;
    format: string;
    connections: number;
    listSubs: boolean;
    defaultSub?: Language | "none";
    subLang?: (Language | "none")[];
    hardsub: boolean;
    attachFonts: boolean;
    subsOnly: boolean;
    output?: string;
    progressBar: boolean;
    retry: number;
    season?: string[];
    episode?: string[];
    cookies: string;
}

let requester: Requester;
let requesterCdn: RequesterCdn;

download
    .name("download").alias("dl")
    .description("Download video or series from URL")
    .arguments("<URL>")
    .option("-f, --format <resolution>", "Video resolution", "1080p")
    .option("--season <LIST>", "A season number or a comma-separated list (without spaces) of season numbers to download. A ```-``` (minus) can be used to specify a range (e.g. ```1,3-5```). Works only for series-links. Note: Season 1 is the bottom-most season on the website.")
    .option("--episode <LIST>", "A comma-separated list of episode numbers to download. A ```-``` (minus) can be used to specify a range (e.g. ```01,03-05,SP2```). If a given episode number exists in multiple seasons, you must specify one with --season.")
    .option("-c, --connections <connections>", "Number of simultaneous connections", "5")
    .option("--sub-lang <LANGS>", "Specify subtitle languages as a comma separated list to include in video. (e.g. deDE,enUS). Set to ```none``` to embed no subtitles. Use --list-subs for available languages. (Default: All available)")
    .option("--default-sub <LANG>", "Specify subtitle language to be set as default. (e.g. enUS). (Default: if --sub-lang defined: first entry, otherwise: crunchyroll default)")
    .option("--attach-fonts", "Automatically download and attach all fonts that are used in subtitles.")
    .option("--list-subs", "Don't download. List all available subtitles for the video.")
    .option("--subs-only", "Download only subtitles. No Video.")
    .option("--hardsub", "Download hardsubbed video stream. Only one subtitle language specified by --default-sub will be included.")
    .option("--retry <N>", "Max number of download attempts before aborting.", "5")
    .option("--cookies <FILE>", "File to read cookies from and dump cookie jar in", "cookies.txt")
    .option("--no-progress-bar", "Hide progress bar.")
    .option("--proxy <url>", "HTTP(s) proxy to access Crunchyroll. This is enough to bypass geo-blocking.")
    .option("--proxy-cdn <url>", "HTTP proxy used to download video files. Not required for bypassing geo-blocking.")
    .option("-o, --output <template>", "Output filename template, see the \"OUTPUT TEMPLATE\" in README for all the info.")
    .action(async function (url: string, cmdObj) {


        const options: Options = {
            proxy: cmdObj.proxy,
            proxyCdn: cmdObj.proxyCdn,
            format: cmdObj.format,
            connections: parseInt(cmdObj.connections),
            listSubs: !!cmdObj.listSubs,
            defaultSub: cmdObj.defaultSub,
            subLang: cmdObj.subLang ? cmdObj.subLang.split(/[, ]/) : undefined,
            hardsub: !!cmdObj.hardsub,
            attachFonts: !!cmdObj.attachFonts,
            subsOnly: !!cmdObj.subsOnly,
            output: cmdObj.output,
            progressBar: !!cmdObj.progressBar,
            retry: parseInt(cmdObj.retry),
            season: cmdObj.season?.split(/[, ]/),
            episode: cmdObj.episode?.split(/[, ]/),
            cookies: cmdObj.cookies,
        };

        if (isNaN(options.connections)) {
            console.log("--connections must be a number");
            return;
        }
        if (isNaN(options.retry)) {
            console.log("--retry must be a number");
            return;
        }

        if (options.defaultSub && options.defaultSub !== "none" && !languages.includes(options.defaultSub)) {
            console.log("--default-sub: Unknown language. Must be one of: none, " + languages.join(", "));
            return;
        }

        if (options.subLang) {
            for (const lang of options.subLang) {
                if (lang !== "none" && !languages.includes(lang)) {
                    console.log("--sub-lang: Unknown language " + util.inspect(lang) + ". Must be one of: none, " + languages.join(", "));
                    return;
                }
            }
        }

        if (!options.subsOnly && !options.listSubs) {
            // ffmpeg is required
            try {
                await verifyFfmpeg();
            } catch (e) {
                console.error("Error: ffmpeg needs to be installed");
                return;
            }
        }

        loadCookies(options);
        requester = getRequester(options);
        requesterCdn = getRequesterCdn(options);
        const crDl = new CrDl({ requester: requester, requesterCdn: requesterCdn });

        try {
            if (/www\.crunchyroll\.com\/([a-z-]{1,5}\/)?[^/]+\/[^/]+-[0-9]+(:?\?.*)?$/.exec(url)) {
                await downloadVideo(url, crDl, options);
            } else if (/www\.crunchyroll\.com\/([a-z-]{1,5}\/)?[^/]+\/?$/.exec(url)) {
                await downloadSeries(url, crDl, options);
            } else {
                console.log("Error: Unsupported URL");
            }
        } catch (error) {
            if (error instanceof UserInputError) {
                console.log(error.message); // Dont print stacktrace
            } else {
                console.log(error);
            }
        }

        saveCookies(options);

    });



async function downloadVideo(url: string, crDl: CrDl, options: Options): Promise<void> {
    options = Object.assign({}, options);
    const tmpDir = "tmp_" + makeid(6) + "/";

    try {



        const media = await crDl.loadEpisode(url);

        if (await media.isPremiumBlocked()) {
            throw new UserInputError("Error: Episode requires a premium account.");
        }
        if (await media.isRegionBlocked()) {
            throw new UserInputError("Error: Episode seems to be blocked in your region. In some cases it's still watchable with a premium account.");
        }

        const subtitles = await media.getSubtitles();

        if (options.listSubs) {
            // List subs. Do not download.
            const subsTable: { title: string; langCode: string; isDefault: boolean }[] = [];
            for (const sub of subtitles) {
                subsTable.push({ title: await sub.getTitle(), langCode: await sub.getLanguage(), isDefault: await sub.isDefault() });
            }
            console.table(subsTable);
            return;
        }

        // Ensure options
        if (!options.defaultSub) {
            if (options.subLang && options.subLang.length > 0) {
                options.defaultSub = options.subLang[0];
            } else if (subtitles.length == 0) {
                options.defaultSub = "none";
            } else {
                options.defaultSub = await media.getDefaultLanguage();
            }
        }
        if (!options.subLang) {
            if (options.hardsub) {
                options.subLang = [options.defaultSub];
            } else {
                options.subLang = [];
                for (const sub of subtitles) {
                    options.subLang.push(await sub.getLanguage());
                }
            }

        }

        // select and download Subs
        let hardsubLang: Language | null = null;
        let subsToInclude: SubToInclude[];
        if (options.hardsub && options.defaultSub !== "none") {
            if (options.subLang.length > 1) throw new UserInputError("Cannot embed multiple subtitles with --hardsub");
            hardsubLang = options.defaultSub;
            subsToInclude = [];

            console.log(`Selected "${hardsubLang}" as hardsub language.`);
        } else {
            hardsubLang = null;
            subsToInclude = await downloadSubs(subtitles, path.join(tmpDir, "SubData"), options.subLang, options.defaultSub);

        }
        if (subsToInclude.length > 0) {
            console.log("Following subtitles will be included: ");
            console.table(subsToInclude, ["title", "langCode", "default"]);
        } else {
            console.log("No subtitles will be included.");
        }

        // download fonts
        let fontsToInclude: string[] = [];
        if (options.attachFonts) {
            fontsToInclude = await downloadFontsFromSubtitles(requesterCdn, options.retry, subsToInclude, path.join(tmpDir, "Fonts"));
        }

        //console.log(fontsToInclude);

        let selectedStream: StreamInfo | undefined = undefined;
        if (!options.subsOnly) {
            const resolution = getMaxWantedResolution(await media.getAvailableResolutions(hardsubLang), options.format);

            // We may get multiple streams on different servers. Just take first.
            selectedStream = (await media.getStreams(resolution, hardsubLang))[0];
        }


        const metadata: Record<string, string> = {
            episodeTitle: await media.getEpisodeTitle(),
            seriesTitle: await media.getSeriesTitle(),
            episodeNumber: await media.getEpisodeNumber(),
            seasonTitle: await media.getSeasonTitle(),
            resolution: options.subsOnly ? "subtitles" : selectedStream?.getHeight() + "p",
        };

        if (!isNaN(parseInt(metadata.episodeNumber))) {
            metadata.episodeNumber = pad(metadata.episodeNumber, 2);
        }

        const formatData: Record<string, string> = {};
        for (const prop in metadata) {
            formatData[prop] = toFilename(metadata[prop]);
        }

        if (!options.output) {
            if (options.subsOnly) {
                options.output = "{seasonTitle} [subtitles]/{seasonTitle} - {episodeNumber} - {episodeTitle}.ass";
            } else {
                options.output = "{seasonTitle} [{resolution}]/{seasonTitle} - {episodeNumber} - {episodeTitle} [{resolution}].mkv";
            }
        }
        let outputPath = format(options.output, formatData);

        const fullPath = path.join(process.cwd(), outputPath);
        if (fullPath.length > 255) {
            // windows doesnt support paths longer than 259(-4 for .tmp extension) characters
            console.log();
            console.log(`Warning: The path is too long (${fullPath.length} characters but only 255 are allowed) and can cause issues. Please use --output <template> to select a shorter path: ${util.inspect(fullPath)}`);
            console.log();

            if (process.platform == "win32") {
                outputPath = "\\\\?\\" + fullPath; // Windows unicode extended-length path 
            }
        }

        console.log(`Downloading to "${outputPath}"...`);

        try {
            await fs.promises.access(outputPath, fs.constants.F_OK);
            console.log("File already exists. Skipping...");
            return;
        } catch (e) {
            // empty
        }

        const outputDirectory = path.dirname(outputPath);
        if (outputDirectory.length > 0) {
            await fs.promises.mkdir(outputDirectory, { recursive: true });
        }
        if (options.subsOnly) {
            await downloadSubsOnly(subsToInclude, outputPath);
        } else {
            //const m3u8File = await downloadVideoFromM3U(selectedStream.getUrl(), "VodVid", options)
            if (!selectedStream) throw new RuntimeError("No stream selcted. Should never happen.");
            await fs.promises.mkdir(path.join(tmpDir, "VodVid"), { recursive: true });

            // === M3u8 File ===
            const m3u8File = new M3uDownloader();
            const m3u8FilePath = path.join(tmpDir, "VodVid.m3u8");
            await m3u8File.load(selectedStream.getUrl(), tmpDir, "VodVid", requesterCdn);
            await fs.promises.writeFile(m3u8FilePath, m3u8File.getModifiedM3u());

            // === Key File ===
            const keyFile = m3u8File.getKeyFile();
            if (keyFile) {

                await ListDownloader.safeDownload(keyFile.url, keyFile.destination, 5, requesterCdn);
            }

            // === Video Files Download ===
            const listDownloader = new ListDownloader(m3u8File.getVideoFiles(), options.retry, options.connections, requesterCdn);
            if (options.progressBar) {
                const bar1 = new cliProgress.Bar({
                    format: "downloading [{bar}] {percentage}% | {downSize}/{estSize} | Speed: {speed}/s | ETA: {myEta}s"
                }, cliProgress.Presets.shades_classic);
                bar1.start(1, 0);
                listDownloader.on("update", (data: DownloadUpdateOptions) => {
                    bar1.setTotal(data.estimatedSize);
                    bar1.update(data.downloadedSize, {
                        downSize: prettyBytes(data.downloadedSize),
                        estSize: prettyBytes(data.estimatedSize),
                        speed: prettyBytes(data.speed),
                        myEta: Math.floor((data.estimatedSize - data.downloadedSize) / data.speed)
                    });
                });
                await listDownloader.startDownload();
                bar1.stop();
            } else {
                let lastPrint = Date.now();
                listDownloader.on("update", (data: DownloadUpdateOptions) => {
                    const now = Date.now();
                    if (now < lastPrint + 1000) return; // Once per second
                    lastPrint += 1000;
                    const s = {
                        percentage: Math.floor(data.downloadedSize / data.estimatedSize * 100),
                        downSize: prettyBytes(data.downloadedSize),
                        estSize: prettyBytes(data.estimatedSize),
                        speed: prettyBytes(data.speed),
                        myEta: Math.floor((data.estimatedSize - data.downloadedSize) / data.speed)
                    };
                    process.stdout.write(`\rdownloading ${s.percentage}% | ${s.downSize}/${s.estSize} | Speed: ${s.speed}/s | ETA: ${s.myEta}s    `);
                });
                await listDownloader.startDownload();
                console.log(); // new line
            }


            // === Video Muxing ===

            const tmpPath = outputPath.substring(0, outputPath.lastIndexOf(".")) + ".tmp" + outputPath.substring(outputPath.lastIndexOf("."));

            const videoMuxer = new VideoMuxer({ input: m3u8FilePath, subtitles: subsToInclude, fonts: fontsToInclude, output: tmpPath });
            let totalDuration = "";

            if (options.progressBar) {
                const bar2 = new cliProgress.Bar({
                    format: "muxing [{bar}] {percentage}% | {curDuration}/{totalDuration} | Speed: {fps} fps"
                }, cliProgress.Presets.shades_classic);
                bar2.start(1, 0);
                videoMuxer.on("total", (totalMilliseconds: number, totalString: string) => {
                    bar2.setTotal(totalMilliseconds);
                    totalDuration = totalString;
                });
                videoMuxer.on("progress", (progressMilliseconds: number, progressString: string, fps: number) => {
                    bar2.update(progressMilliseconds, {
                        curDuration: progressString,
                        totalDuration: totalDuration,
                        fps
                    });
                });
                const output: string[] = [];
                videoMuxer.on("info", (data: string) => {
                    if (data.match(/Opening .* for reading/)) return; //Spam
                    else if (data.startsWith("frame=")) return; //status
                    else output.push(data); // Remember in case of error
                });
                try {
                    await videoMuxer.run();
                    bar2.stop();
                } catch (e) {
                    // Error: print ffmpeg output
                    bar2.stop();
                    console.log("ffmpeg output: " + output.join("\r\n"));
                    throw e;
                }

            } else {
                videoMuxer.on("info", (data: string) => {
                    if (data.match(/Opening .* for reading/)) return; //Spam
                    else if (data.startsWith("frame=")) process.stdout.write("\r" + data); //replace line
                    else console.log(data);
                });
                await videoMuxer.run();
            }
            await fs.promises.rename(tmpPath, outputPath);
        }
    } finally {
        try {
            deleteFolderRecursive(tmpDir);
        } catch (e) {
            // empty
        }
    }


}

async function downloadSubsOnly(subtitlesToInclude: SubToInclude[], outputPath: string): Promise<void> {
    if (outputPath.lastIndexOf("/") < outputPath.lastIndexOf(".")) {
        outputPath = outputPath.substr(0, outputPath.lastIndexOf("."));
    }
    for (const sub of subtitlesToInclude) {
        await fs.promises.rename(sub.path, `${outputPath}.${sub.langCode}.ass`);
    }
}

async function downloadSeries(url: string, crDl: CrDl, options: Options): Promise<void> {

    const list = await crDl.getEpisodesFormUrl(url);

    let seasonsToDownload = list;

    // select season(s)
    if (options.season) {
        const wantedSeasons: number[] = options.season.flatMap<number, string>((currentValue: string) => {
            const bounds = currentValue.split("-");

            if (bounds.length == 1) {
                if (isNaN(parseInt(bounds[0]))) throw new UserInputError(`Season number "${bounds[0]}" invalid.`);
                return parseInt(bounds[0]) - 1;
            } else if (bounds.length == 2) {
                if (isNaN(parseInt(bounds[0]))) throw new UserInputError(`Season number "${bounds[0]}" invalid.`);
                if (isNaN(parseInt(bounds[1]))) throw new UserInputError(`Season number "${bounds[1]}" invalid.`);
                const r: number[] = [];
                for (let i = parseInt(bounds[0]); i <= parseInt(bounds[1]); i++) {
                    r.push(i - 1);
                }
                return r;
            } else {
                throw new UserInputError(`Season number "${currentValue}" invalid.`);
            }
        });
        seasonsToDownload = [];
        for (const s of wantedSeasons) {
            if (!list[s]) throw new UserInputError(`Season ${s + 1} not available.`);
            seasonsToDownload.push(list[s]);
        }
    }


    // notify of restricted seasons
    for (const s of seasonsToDownload) {
        if (s.isRegionBlocked) {
            console.log(`Notice: Season "${s.name}" is not available in your region and will be skipped.`);
        } else if (s.isLanguageUnavailable) {
            console.log(`Notice: Season "${s.name}" is not available in selected language and will be skipped.`);
        } else if (s.episodes.length === 0) {
            console.log(`Notice: Season "${s.name}" has no episodes and will be skipped.`);
        }
    }

    // Remove empty seasons
    seasonsToDownload = seasonsToDownload.filter(s => s.episodes.length > 0);
    if (seasonsToDownload.length == 0) throw new UserInputError("No Episodes found.");

    // select episode(s)
    if (options.episode) {
        // if episode number numeric, convert string to number and back to string to normalize representation (e.g. leading zeros)
        seasonsToDownload.forEach(s => s.episodes.forEach(e => { if (!isNaN(Number(e.number))) e.number = Number(e.number).toString(); }));

        type episodePosition = { seasonIndex: number; episodeIndex: number };

        const getEpisodeFromNumber = (number: string): episodePosition => {
            if (!isNaN(Number(number))) number = Number(number).toString();

            const results: episodePosition[] = [];
            for (let seasonIndex = 0; seasonIndex < seasonsToDownload.length; seasonIndex++) {
                const season = seasonsToDownload[seasonIndex].episodes;
                for (let episodeIndex = 0; episodeIndex < season.length; episodeIndex++) {
                    const episode = season[episodeIndex];
                    if (episode.number == number) {
                        results.push({ seasonIndex, episodeIndex });
                    }
                }
            }
            if (results.length == 0) {
                throw new UserInputError(`Episode "${number}" not found.`);
            } else if (results.length == 1) {
                return results[0];
            } else {
                let areAllMatchesInSameSeason = true;
                for (let index = 0; index < results.length - 1; index++) {
                    if (results[index].seasonIndex != results[index + 1].seasonIndex)
                        areAllMatchesInSameSeason = false;
                }
                if (areAllMatchesInSameSeason) {
                    // allow multiple matches within a season otherwise we wouldn't be able to specify an episode
                    console.log(`Warning: Multiple episodes found matching "${number}". Selecting first.`);
                    return results[0];
                } else {
                    throw new UserInputError(`Collision between seasons for episode "${number}". Please specify one season with --season to use --episode.`);
                }
            }
        };
        const addEpisodesInRange = (start: episodePosition, end: episodePosition): Episode[] => {
            let curSeason = start.seasonIndex;
            let curEpisode = start.episodeIndex;
            const result: Episode[] = [];

            while (curSeason < end.seasonIndex || (curSeason == end.seasonIndex && curEpisode <= end.episodeIndex)) {
                result.push(seasonsToDownload[curSeason].episodes[curEpisode]);

                if (curEpisode < seasonsToDownload[curSeason].episodes.length - 1) {
                    curEpisode++;
                } else {
                    // Range between seasons
                    curSeason++;
                    curEpisode = 0;
                }
            }
            return result;
        };


        const episodesToDownload = options.episode.flatMap(n => {
            const bounds = n.split("-");
            if (bounds.length == 1) {
                const ep = getEpisodeFromNumber(n);
                return seasonsToDownload[ep.seasonIndex].episodes[ep.episodeIndex];
            } else if (bounds.length == 2) {
                const min = getEpisodeFromNumber(bounds[0]);
                const max = getEpisodeFromNumber(bounds[1]);
                return addEpisodesInRange(min, max);
            } else {
                throw new UserInputError("Invalid episode number: " + n);
            }
        });

        seasonsToDownload.forEach(value => { value.episodes = value.episodes.filter(ep => episodesToDownload.includes(ep)); });
    }



    // Remove empty seasons (again)
    seasonsToDownload = seasonsToDownload.filter(s => s.episodes.length > 0);

    if (seasonsToDownload.length == 0) throw new UserInputError("No Episodes selected.");



    //console.log(require('util').inspect(seasonsToDownload, false, null, true /* enable colors */))

    console.log("Following episodes will be dowloaded:");

    for (const s of seasonsToDownload) {
        if (s.name !== "") console.log(`Season "${s.name}":`);
        console.log(s.episodes.map(e => e.number).join(", "));
        console.log();
    }

    for (const season of seasonsToDownload) {
        for (const episode of season.episodes) {
            console.log();
            console.log(`Downloading S(${pad(seasonsToDownload.indexOf(season) + 1, 2)}/${pad(seasonsToDownload.length, 2)})E(${pad(season.episodes.indexOf(episode) + 1, 2)}/${pad(season.episodes.length, 2)}) - ${episode.name}`);
            await downloadVideo("http://www.crunchyroll.com" + episode.url, crDl, options);
        }
    }
}



async function getSubtitleByLanguage(subtitles: SubtitleInfo[], language: Language): Promise<SubtitleInfo | undefined> {
    let sub: SubtitleInfo | undefined = undefined;
    for (const subt of subtitles) {
        if (await subt.getLanguage() == language) {
            sub = subt;
            break;
        }
    }
    return sub;
}
interface SubToInclude {
    title: string;
    path: string;
    language: string;
    langCode: Language;
    default: boolean;
}
async function downloadSubs(subtitles: SubtitleInfo[], destination: string, langs: (Language | "none")[], defaultSub: Language | "none"): Promise<SubToInclude[]> {
    const subsToInclude: SubToInclude[] = [];
    await fs.promises.mkdir(destination, { recursive: true });
    for (const lang of langs) {
        if (lang == "none") continue;

        const sub = await getSubtitleByLanguage(subtitles, lang);
        if (!sub) {
            console.error("Subtitles for " + lang + " not available. Skipping...");
        } else {
            const filePath = path.join(destination, await sub.getLanguage() + ".ass");
            fs.promises.writeFile(filePath, await sub.getData());
            subsToInclude.push({
                title: await sub.getTitle(),
                path: filePath,
                language: await sub.getLanguageISO6392T(),
                langCode: await sub.getLanguage(),
                default: false
            });
        }
    }

    if (defaultSub != "none") {
        let defaultSet = false;
        for (const sub of subsToInclude) {
            if (sub.langCode == defaultSub) {
                sub.default = true;
                defaultSet = true;
            } else {
                sub.default = false;
            }
        }
        if (!defaultSet) {
            throw new UserInputError("Couldn't set " + defaultSub + " as default subtitle: subtitle not available.");
        }
    }

    return subsToInclude;
}

function getMaxWantedResolution(availableResolutions: number[], res: number | string): number {
    if (typeof res == "string" && res.endsWith("p")) {
        res = res.substr(0, res.length - 1);
    }
    res = parseInt(res as string);
    if (isNaN(res)) throw new UserInputError("Invalid resolution.");

    if (availableResolutions.indexOf(res) > -1) {
        return res;
    }
    availableResolutions = availableResolutions.sort((a, b) => a - b);
    console.log(availableResolutions);
    for (let i = availableResolutions.length - 1; i >= 0; i--) {
        if (availableResolutions[i] <= res) {
            console.log(`Resolution ${res}p not available. Using ${availableResolutions[i]}p instead.`);
            return availableResolutions[i];
        }
    }
    throw new RuntimeError("No resolutions found.");

}

function verifyFfmpeg(): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn("ffmpeg");
        proc.on("error", (err) => {
            reject(err);
        });
        proc.on("close", () => {
            resolve();
        });
    });
}

