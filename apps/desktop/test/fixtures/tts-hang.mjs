// 测试用的「永远不 ready」的假 python：进程活着，但不打印 ready，用来测加载超时。
setInterval(() => {}, 1000);
