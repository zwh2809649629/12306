# -*- coding: utf-8 -*-
"""
站名解析 —— webx 的统一入口（本地站点表 + 12306 官方站名表 + 同城站展开）

为什么需要它（两条都是实测踩出来的）：

1. **本地站点表不全**。`data/stations.txt`（3319 站）不含新开站：
   「湛江北」「茂名南」「番禺」都查不到。12306 自己的站名表（3385 站）是全的，
   所以按「本地 → 余票响应累积 → 官方站名表」三级兜底解析电报码。

2. ★ **12306 查询会做「同城站扩展」，而引擎不校验行的实际到发站**。
   实测：查「深圳北 → 广州南」返回 **567 条**结果，其中
     到达站：广州南 208 / 广州东 132 / 新塘 87 / 广州 55 / 广州白云 42 / 广州北 38 / 番禺 3 / 花都 2
     出发站：深圳北 277 / 福田 64 / 深圳 205 / 深圳东 16 / 深圳机场 5
   而 `Job.is_trains_number_valid()` 只判「出发时段 + 车次白名单」，**完全没看站名** →
   引擎会把「深圳北 → 广州东」的票也一起抢下来（实测真的下了单）。
   修法见 `engine_hooks._hook_station_filter()`：按 `expand()` 的结果过滤行的实际站。

`expand()` 用的是**前缀规则**（与 12306 站名命名规则一致：城市名 + 方位）：
    深圳北 → [深圳北]                                  ← 具体站只匹配自己
    广州南 → [广州南]
    广州   → [广州, 广州东, 广州南, 广州西, 广州北, 广州白云]   ← 城市名保留「全站」语义
    北京   → [北京, 北京东, 北京南, 北京西, 北京北, 北京朝阳, 北京丰台, 北京大兴]
    番禺   → [番禺]（只有官方表有）
**未知站名返回 None**（而不是空集合）—— 调用方据此「不过滤」，
避免把用户输错的站名变成「一条也抢不到」的静默失败。
"""
import json
import os
import re
import threading
import time

from py12306.config import Config

# ---- 12306 官方站名表 ----
STATION_JS_URL = 'https://kyfw.12306.cn/otn/resources/js/framework/station_name.js'
_STATION_JS_TTL = 7 * 24 * 3600       # 落盘缓存有效期
_STATION_JS_RETRY = 300               # 拉取失败后的重试间隔（别把 12306 打爆）

_state = {
    'official': None,                 # name → 电报码
    'official_at': 0.0,
    'busy': False,
    'extra': {},                      # 余票响应 data.map 累积的 name → 电报码
    'names': None,                    # 全部站名（本地 ∪ 官方）缓存
    'names_at': 0.0,
}
_lock = threading.Lock()


def _cache_path():
    return Config().RUNTIME_DIR + 'station_codes.json'


def _read_disk():
    path = _cache_path()
    try:
        if os.path.exists(path) and (time.time() - os.path.getmtime(path)) < _STATION_JS_TTL:
            with open(path, 'r', encoding='utf-8') as fh:
                return json.load(fh) or {}
    except Exception:
        pass
    return {}


def _fetch_official(session=None):
    """从 12306 拉站名表；`station_names = '@拼音|站名|电报码|...@...'`"""
    table = {}
    try:
        if session is None:
            from py12306.webx.server.routes_tickets import _query_session     # 延迟导入避免循环
            session = _query_session()
        resp = session.get(STATION_JS_URL, timeout=Config().TIME_OUT_OF_REQUEST)
        m = re.search(r"station_names\s*=\s*'(.*?)'", resp.text or '', re.S)
        if m:
            for item in m.group(1).split('@'):
                parts = item.split('|')
                if len(parts) >= 3 and parts[1] and parts[2]:
                    table[parts[1]] = parts[2].upper()
        if table:
            path = _cache_path()
            with open(path + '.tmp', 'w', encoding='utf-8') as fh:
                json.dump(table, fh, ensure_ascii=False)
            os.replace(path + '.tmp', path)
    except Exception:
        table = {}
    return table


def official(session=None):
    """官方 站名→电报码。懒加载：先读落盘缓存，过期/缺失才拉网络。"""
    if _state['official']:
        return _state['official']
    with _lock:
        if _state['official']:
            return _state['official']
        now = time.time()
        if _state['busy'] or (now - _state['official_at']) < _STATION_JS_RETRY:
            return {}
        table = _read_disk()
        if not table:
            _state['busy'] = True
            try:
                table = _fetch_official(session)
            finally:
                _state['busy'] = False
                _state['official_at'] = now
        else:
            _state['official_at'] = now
        if table:
            _state['official'] = table
            _state['names'] = None        # 站名集合随之失效
        return table


def remember(station_map):
    """
    把一次余票响应的 `data.map`（电报码 → 站名）累积起来。
    免费、精确，但**只含本次查询涉及的站**，所以只是补充源。
    """
    try:
        with _lock:
            for code, name in (station_map or {}).items():
                if code and name:
                    _state['extra'].setdefault(str(name), str(code))
    except Exception:
        pass


def local_names():
    try:
        from py12306.helpers.station import Station
        return [s.get('name') for s in Station().stations if s.get('name')]
    except Exception:
        return []


def names():
    """全部已知站名（本地 ∪ 官方 ∪ 余票累积），已排序去重。"""
    if _state['names']:
        return _state['names']
    merged = set(local_names())
    merged.update((official() or {}).keys())
    merged.update(_state['extra'].keys())
    out = sorted(n for n in merged if n)
    if out:
        _state['names'] = out
    return out


def code_of(name):
    """站名 → 电报码；解析不出来返回 None"""
    s = str(name or '').strip()
    if not s:
        return None
    try:
        from py12306.helpers.station import Station
        code = Station.get_station_key_by_name(s)
        if code:
            return code
    except Exception:
        pass
    if s in _state['extra']:
        return _state['extra'][s]
    return (official() or {}).get(s)


def expand(name):
    """
    该输入会匹配到的**实际车站名**列表（前缀规则，具体站只匹配自己）。

    - 解析不出来（不在任何站名表里）→ 返回 `None`，调用方应据此**不过滤**，
      避免把输错的站名变成「一条也抢不到」的静默失败。
    - 结果是排好序的（短的在前），便于直接展示给用户看。
    """
    s = str(name or '').strip()
    if not s:
        return None
    hit = [n for n in names() if n.startswith(s)]
    if not hit:
        return None
    hit.sort(key=lambda n: (len(n), n))
    return hit


def is_known(name):
    return expand(name) is not None


def _code_index():
    """电报码 → 站名。同样要并入官方表：本地表缺新站（实测余票响应里出现过 `PYA`，
    本地表查不到 → 引擎的 `get_info_of_left_station()` 会直接抛 AttributeError）。"""
    idx = _state.get('codes')
    if idx:
        return idx
    out = {}
    try:
        from py12306.helpers.station import Station
        for s in Station().stations:
            k, n = (s.get('key') or '').upper(), s.get('name')
            if k and n:
                out.setdefault(k, n)
    except Exception:
        pass
    for n, code in (official() or {}).items():
        out.setdefault(str(code).upper(), n)
    for n, code in _state['extra'].items():
        out.setdefault(str(code).upper(), n)
    if out:
        _state['codes'] = out
    return out


def name_of(code):
    """电报码 → 站名；查不到返回 None（也不抛异常）"""
    k = str(code or '').strip().upper()
    return _code_index().get(k) if k else None


def describe(name, mode='exact'):
    """
    给界面用的一句话说明：这个输入会匹配哪些站。

    `mode`（默认 `exact`，与新建任务的默认一致）：
      - `exact`（仅指定站名）：只认完全同名的站 —— `广州` 只算 `广州` 一个站。
        输入不是完整站名（如 `番`）时无法工作，界面要能看出来。
      - `expand`（同城站扩展）：按前缀展开 —— `广州` 会匹配 10 个广州站，
        `深圳北` 只匹配自己。这是 12306 查询结果的实际形态（同城其它站也会返回）。

    `exact` 字段表示输入本身就是某个完整站名（从下拉里选过 / 手打完整）；
    `note` 是给用户看的一句话。
    """
    s = str(name or '').strip()
    hit = expand(s)
    if hit is None:
        return {'input': s, 'known': False, 'exact': False, 'mode': mode, 'matches': [],
                'note': '未收录该车站，请检查拼写'}
    full = s in names()
    if mode == 'exact':
        if not full:
            return {'input': s, 'known': True, 'exact': False, 'mode': mode, 'matches': [],
                    'note': '不是完整站名，「仅指定站名」下无法使用（请从下拉里选）'}
        return {'input': s, 'known': True, 'exact': True, 'mode': mode, 'matches': [s],
                'note': '只匹配 %s' % s}
    if full and len(hit) == 1:
        note = '只匹配 %s' % hit[0]
    elif full:
        note = '按城市匹配 %d 个车站：%s' % (len(hit), '、'.join(hit))
    else:
        note = '按前缀匹配 %d 个车站：%s（建议从下拉里选具体站）' % (len(hit), '、'.join(hit))
    return {'input': s, 'known': True, 'exact': full, 'mode': mode, 'matches': hit, 'note': note}


def is_exact_name(name):
    """输入是否是一个完整站名（用于「仅指定站名」模式的校验）"""
    return str(name or '').strip() in names()
