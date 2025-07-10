import { BaseClient, BaseClientOptions, ClientFetchManyOptions, ClientInterface, ClientRequestOptions, defaultUserAgent, delay, FaliedAttempt, HttpResponse, InvalidStatusCodeError } from "@xcrap/core"
import { connect, Options as ConnectOptions } from "puppeteer-real-browser"
import { Browser, Page } from "rebrowser-puppeteer-core"

import { defaultPuppeteerActionType } from "./constants"

export type PuppeteerRealBrowserProxy = string
export type PuppeteerRealBrowserClientOptions = BaseClientOptions<PuppeteerRealBrowserProxy> & ConnectOptions

export enum PuppeteerRealBrowserClientActionType {
    BeforeRequest = "beforeRequest",
    AfterRequest = "afterRequest"
}

export type PuppeteerRealBrowserClientActionFunction = (page: Page) => any | Promise<any>

export type PuppeteerRealBrowserClientAction = PuppeteerRealBrowserClientActionFunction | {
    type: `${PuppeteerRealBrowserClientActionType}`
    exec: PuppeteerRealBrowserClientActionFunction
}

export type ExtractActionsResult = {
    before: PuppeteerRealBrowserClientActionFunction[]
    after: PuppeteerRealBrowserClientActionFunction[]
}

export type PuppeterRequestOptions = Omit<ClientRequestOptions & {
    javaScriptEnabled?: boolean
    actions?: PuppeteerRealBrowserClientActionFunction[]
}, "method">

export type ConfigurePageOptions = {
    javaScriptEnabled: PuppeterRequestOptions["javaScriptEnabled"]
}

export type PuppeteerFetchManyOptions = ClientFetchManyOptions<PuppeterRequestOptions>

export class PuppeteerRealBrowserClient extends BaseClient<string> implements ClientInterface {
    protected browser?: Browser

    constructor(readonly options: PuppeteerRealBrowserClientOptions = {}) {
        super(options)

        this.options = options
        this.browser = undefined
    }

    protected async initBrowser(): Promise<void> {
        const puppeteerArguments: string[] = []

        if (this.proxy) {
            puppeteerArguments.push(`--proxy-server=${this.currentProxy}`)
        }

        if (this.options.args && this.options.args.length > 0) {
            puppeteerArguments.push(...this.options.args)
        }

        const { browser: connectedBrowser } = await connect({
            ...this.options,
            args: puppeteerArguments,
            headless: this.options.headless
        })

        this.browser = connectedBrowser
    }

    protected async ensureBrowser(): Promise<void> {
        if (!this.browser) {
            await this.initBrowser()
        }
    }

    protected async closeBrowser(): Promise<void> {
        if (this.browser) {
            await this.browser.close()
            this.browser = undefined
        }
    }

    protected async configurePage(page: Page, { javaScriptEnabled }: ConfigurePageOptions): Promise<void> {
        if (this.currentUserAgent) {
            await page.setUserAgent(this.currentUserAgent ?? defaultUserAgent)
        }

        if (javaScriptEnabled !== undefined) {
            await page.setJavaScriptEnabled(javaScriptEnabled)
        }
    }

    protected extractActions(actions: PuppeteerRealBrowserClientAction[] | undefined): ExtractActionsResult {
        const actionsBeforeRequest: PuppeteerRealBrowserClientActionFunction[] = []
        const actionsAfterRequest: PuppeteerRealBrowserClientActionFunction[] = []

        if (!actions) {
            actions = []
        }

        for (const action of actions) {
            const actionType = typeof action === "function" ? defaultPuppeteerActionType : action.type
            const actionFunc = typeof action === "function" ? action : action.exec

            if (actionType === "beforeRequest") {
                actionsBeforeRequest.push(actionFunc)
            } else {
                actionsAfterRequest.push(actionFunc)
            }
        }

        return {
            before: actionsBeforeRequest,
            after: actionsAfterRequest
        }
    }

    protected async executeActions(page: Page, actions: PuppeteerRealBrowserClientActionFunction[]): Promise<void> {
        for (const action of actions) {
            await action(page)
        }
    }

    async fetch({
        url,
        javaScriptEnabled,
        maxRetries = 0,
        actions,
        retries = 0,
        retryDelay,
    }: PuppeterRequestOptions): Promise<HttpResponse> {
        await this.ensureBrowser()

        const failedAttempts: FaliedAttempt[] = []

        const attemptRequest = async (currentRetry: number): Promise<HttpResponse> => {
            let page: Page | undefined = undefined

            try {
                const fullUrl = this.currentProxyUrl ? `${this.currentProxyUrl}${url}` : url

                const {
                    before: actionsBeforeRequest,
                    after: actionsAfterRequest
                } = this.extractActions(actions)

                page = await this.browser!.newPage()

                await this.configurePage(page, { javaScriptEnabled: javaScriptEnabled })
                await this.executeActions(page, actionsBeforeRequest)
                const response = await page.goto(fullUrl)
                await this.executeActions(page, actionsAfterRequest)
                const content = await page.content()
                await page.close()

                const status = response?.status()

                if (status === undefined || !this.isSuccess(status)) {
                    throw new InvalidStatusCodeError(status ?? 500)
                }

                return new HttpResponse({
                    body: content,
                    headers: response?.headers() || {},
                    status: response?.status() || 200,
                    statusText: response?.statusText() || "Ok",
                    attempts: currentRetry + 1,
                    failedAttempts: failedAttempts,
                })
            } catch (error: any) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error"

                failedAttempts.push({ error: errorMessage, timestamp: new Date() })

                if (page) {
                    await page.close().catch(() => { })
                }

                if (currentRetry < maxRetries) {
                    if (retryDelay !== undefined && retryDelay > 0) {
                        await delay(retryDelay)
                    }

                    return await attemptRequest(currentRetry + 1)
                }

                return new HttpResponse({
                    body: errorMessage,
                    headers: {},
                    status: error.status || 500,
                    statusText: "Request Failed",
                    attempts: currentRetry + 1,
                    failedAttempts: failedAttempts,
                })
            }
        }

        return await attemptRequest(retries)
    }

    async fetchMany({ requests, concurrency, requestDelay }: PuppeteerFetchManyOptions): Promise<HttpResponse[]> {
        const results: HttpResponse[] = []
        const executing: Promise<void>[] = []

        for (let i = 0; i < requests.length; i++) {
            const promise = this.executeRequest({
                request: requests[i],
                index: i,
                requestDelay: requestDelay,
                results: results
            }).then(() => undefined)

            executing.push(promise)

            if (this.shouldThrottle(executing, concurrency)) {
                await this.handleConcurrency(executing)
            }
        }

        await Promise.all(executing)

        return results
    }

    async close(): Promise<void> {
        if (this.browser) {
            await this.closeBrowser()
        }
    }
}