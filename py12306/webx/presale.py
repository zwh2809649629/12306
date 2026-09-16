# -*- coding: utf-8 -*-
"""
webx 预售期（唯一事实来源）

2026-09 实测 12306 行为：超出预售期的日期，余票接口返回的不是 JSON，
而是 **HTML 错误页**（Content-Type: text/html）。边界非常干净：

    today+0  ~ today+14  →  200 + JSON（带 data.result）
    today+15 起          →  text/html 错误页

即当前 **预售期 15 天（含今天）**。

原先 webx 在 3 处各自硬编码了 32 天：
  - routes_jobs./api/dates 返回 32 天
  - routes_orders.MAX_BUY_DAYS = 32
  - 前端日期条直接渲染全部
导致后 17 天的日期「可点、可填、必然失败」，且报错信息还是误导性的
「返回内容异常」。此处收敛为单一来源，并允许 runtime/webx.json 的
query.presale_days 覆盖（12306 会不定期调整预售期）。
"""
import datetime

DEFAULT_PRESALE_DAYS = 15
# 日期条上额外多展示几天「未开售」，让用户能直接看到为什么点不了
BLOCKED_TAIL_DAYS = 5
WEEKDAYS = '一二三四五六日'


def presale_days():
    try:
        from py12306.webx.config_store import ConfigStore
        value = int((ConfigStore().get().get('query') or {}).get('presale_days'))
        if 1 <= value <= 90:
            return value
    except Exception:
        pass
    return DEFAULT_PRESALE_DAYS


def _today():
    return datetime.date.today()


def first_date():
    return _today()


def last_date():
    return _today() + datetime.timedelta(days=presale_days() - 1)


def parse(date_str):
    try:
        return datetime.datetime.strptime(str(date_str)[:10], '%Y-%m-%d').date()
    except Exception:
        return None


def is_open(date_str):
    """日期是否在预售期内。格式非法或超期均返回 False。"""
    d = parse(date_str)
    if d is None:
        return False
    return first_date() <= d <= last_date()


def note():
    return '预售期 %d 天 · 可选 %s ~ %s' % (
        presale_days(), first_date().isoformat(), last_date().isoformat())


def too_early_msg(date_str):
    """面向用户的精确提示"""
    d = parse(date_str)
    if d is None:
        return '日期格式应为 YYYY-MM-DD'
    if d < first_date():
        return '出发日期不能早于今天（%s）' % first_date().isoformat()
    return '该日期尚未开售：%s（%s）' % (date_str, note())


def window_dates(include_blocked_tail=True):
    """
    日期条数据：预售期内 open=True，其后若干天 open=False（仅供提示，不可点）。
    保留 date/weekday/tag 字段以兼容既有前端。
    """
    total = presale_days() + (BLOCKED_TAIL_DAYS if include_blocked_tail else 0)
    out = []
    for i in range(total):
        d = _today() + datetime.timedelta(days=i)
        opened = i < presale_days()
        out.append({
            'date': d.isoformat(),
            'weekday': WEEKDAYS[d.weekday()],
            'day': '%02d-%02d' % (d.month, d.day),
            'tag': 'today' if i == 0 else '',
            'open': opened,
            'label': '' if opened else '未开售',
        })
    return out
