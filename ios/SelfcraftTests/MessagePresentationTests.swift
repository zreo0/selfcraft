import Foundation
import Testing
@testable import Selfcraft

/** 来源按完整网址去重，同域不同页面不可丢失，非网页链接不进入引用 */
@Test func sourcesPreserveDistinctPages() throws {
    let parts = try JSONDecoder().decode([JSONValue].self, from: Data("""
    [
        {"type":"source-url","url":"https://v2ex.com/t/1","title":"话题一"},
        {"type":"source-url","url":"https://v2ex.com/t/1","title":"重复"},
        {"type":"source-url","url":"https://v2ex.com/t/2","title":"话题二"},
        {"type":"source-url","url":"https://tophub.today/","title":""},
        {"type":"source-url","url":"javascript:alert(1)"}
    ]
    """.utf8))
    let presentation = MessagePresentation(parts: parts)
    #expect(presentation.sources.count == 3)
    #expect(presentation.websiteCount == 2)
    #expect(presentation.sources.map(\.title) == ["话题一", "话题二", "tophub.today"])
}

/** 同一调用使用最新快照，失败与未知不得被摘要显示为全部完成 */
@Test func activitySummaryKeepsIncompleteStates() throws {
    let parts = try JSONDecoder().decode([JSONValue].self, from: Data("""
    [
        {"type":"data-activity","data":{"items":[{"id":"a","label":"阅读网页","state":"running"}]}},
        {"type":"data-activity","data":{"items":[
            {"id":"a","label":"阅读网页","state":"success"},
            {"id":"b","label":"运行命令","state":"error"},
            {"id":"c","label":"查找事项","state":"unknown"}
        ]}}
    ]
    """.utf8))
    let presentation = MessagePresentation(parts: parts)
    #expect(presentation.activities.map(\.id) == ["a", "b", "c"])
    #expect(presentation.unfinishedCount == 2)
    #expect(presentation.activitySummary(streaming: false, failed: false, hasText: true) == "3 项操作 · 2 项未完成")
    #expect(presentation.activitySummary(streaming: false, failed: true, hasText: true) == "回复已中断 · 查看过程")
    #expect(presentation.activitySummary(streaming: true, failed: false, hasText: false) == "正在整理回答")
    let working = MessagePresentation(parts: [parts[0]])
    #expect(working.activitySummary(streaming: true, failed: false, hasText: false) == "正在阅读网页")
    #expect(working.activitySummary(streaming: false, failed: false, hasText: true) == "1 项操作 · 1 项未完成")
}
