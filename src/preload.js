'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE = new Set([
  'app:info',
  'library:load',
  'library:save',
  'library:scan',
  // 文件夹拖进分类：扫成分类树（主文件夹 → 子文件夹）
  'library:scan-tree',
  'drag:inspect',
  'dialog:pick-files',
  'dialog:pick-folder',
  'audio:inspect',
  // 导入时批量读文件头（几毫秒）；波形峰值单独按需取，走工作线程
  'audio:probe',
  'audio:peaks',
  'audio:window',
  'audio:tags',
  'audio:trim',
  'audio:clip',
  'audio:save-wav',
  // 生成的底噪落到 <userData>\generated\ 里（数据目录可搬盘，所以由主进程决定位置）
  'synth:save',
  'synth:stage',
  'synth:open-folder',
  // 开着效果器时拖出去的版本，离线渲染好之后落到 cache\fx\ 里
  'audio:fx-wav',
  // 采样器渲染的版本，落到 cache\sampler\ 里
  'audio:sampler-wav',
  // 响度 / 峰值 / 频谱图（本地算，不用 ffmpeg）
  'audio:deep',
  // 找回丢失素材：批量探路径 + 把 UCS 字段写回 WAV
  'fs:exists',
  'audio:write-info',
  // 批量工作流：复制到工程目录 / 按 UCS 改名 / 导出选片单
  'files:copy',
  'files:rename',
  'dialog:save-text',
  // 存储更换（搬 data\ 到别的盘）与清单备份
  'storage:info',
  'storage:migrate',
  'storage:reset',
  'backup:list',
  'backup:create',
  'backup:restore',
  'app:relaunch',
  'art:cover',
  'file:exists',
  'shell:reveal',
  'shell:open',
  'cache:size',
  'cache:clear',
  // 贴边隐藏：主进程管窗口位置，渲染层只管开关和布局
  'dock:set',
  'dock:state',
  'dock:pin',
  'dock:toggle',
  'dock:peek',
  // 拖边境调宽度 / 把窗口从贴边状态拖走
  'dock:resize-start',
  'dock:resize',
  'dock:resize-end',
  'window:detach',
  'window:move-to',
  // Agent 检索：密钥存在主进程，渲染层只拿 hasKey
  'agent:config-load',
  'agent:config-save',
  'agent:profiles',
  'agent:profile-activate',
  'agent:profile-save',
  'agent:profile-delete',
  'agent:chat',
  'agent:test',
  // 云端音频生成：同样只拿 hasKey / keyTail，密钥不出主进程
  'gen:profiles',
  'gen:profile-save',
  'gen:profile-activate',
  'gen:profile-delete',
  'gen:generate',
  'gen:balance',
  // 本机插件清单（只读）
  'plugins:scan',
  'vst:status',
  'vst:names',
  'vst:params',
  'vst:render',
  // Resolves only once the OS drag has ended, which is what tells the renderer
  // its own drag is over.
  'drag:start'
]);

const SEND = new Set([
  // 渲染层的「界面还活着」心跳，主进程用它判断窗口是不是卡住了
  'ui:alive'
]);

// 主进程推给渲染层的事件（贴边状态变化 / 快捷键没开关时的提示）
const EVENTS = new Set(['dock:mode', 'dock:hint']);

contextBridge.exposeInMainWorld('sb', {
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error('blocked channel: ' + channel));
    return ipcRenderer.invoke(channel, ...args);
  },
  send(channel, ...args) {
    if (!SEND.has(channel)) return;
    ipcRenderer.send(channel, ...args);
  },
  /**
   * 订阅主进程发来的事件，返回取消订阅的函数。
   * 只认白名单里的通道，避免把整个 ipcRenderer 暴露给页面。
   */
  on(channel, cb) {
    if (!EVENTS.has(channel) || typeof cb !== 'function') return () => {};
    const handler = (_event, data) => {
      try { cb(data); } catch (err) { console.error('sb.on handler failed', err); }
    };
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  /**
   * Electron removed File.path; this is the supported replacement for turning
   * a dropped File into a real filesystem path.
   */
  getPathForFile(file) {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  }
});
