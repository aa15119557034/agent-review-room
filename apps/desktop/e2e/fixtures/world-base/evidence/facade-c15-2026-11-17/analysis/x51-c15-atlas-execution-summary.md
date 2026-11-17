# C15 运行与实际图集核对

源码96ddf39ce4ca6448acf1a59dcc49dbf4ca4908ac。正常一次 session87880/PID59144，实际exit1/renderOk true，仅boulders与menhir ERR_ABORTED；定向一次 session54034/PID67136，实际exit0，21/21图，source/driver/9assets/restore全true。GPU已释放，不追加运行。原stdout/stderr在同目录 x51-c15-{normal,targeted}-{stdout,stderr}.txt，原process.json在各artifact目录。

执行记录 x51-c15-execution-receipt.json 是事后据实际工具返回及原日志编写，明确不是运行时supervisor receipt。服务CPU原命令确实exit0（工具chunk9c0262，4.576s），但当时没有单独process receipt；不得补造。

实际 shopsA atlas：lit5页、glow1、cut1、inner2，每页1024²。新增laundry使用lit第4页（0起），生产分配before/after均5页；实际纹理version/sourceVersion/uploadedVersion均4，hasGLTexture true，GLerror0。scene中一份city-local MeshToonMaterial clone指向该同一纹理对象，2个mesh使用（2+6tri），sameMaterialAsPage false。其他未上传页没有当前station/city material使用者，不能误称laundry漏上传。

三张原像素裁图已实际查看：name512×96、function256×96、aframe192×192，字形分别为“さくら コインランドリー”、“洗濯・乾燥 / セルフサービス”、四行A牌文案；7次对应fillText调用实际落在lit页4。crop非空颜色数199/209/225。原文件位于 gpu-look-c15-v1/laundry-atlas-{name,function,aframe}.png；scene-assets-audit.json保存全部page像素SHA/版本/材料identity和实际文本调用。

这证明当前canvas有正确文字、实际材质绑定同一已上传version4的page；没有独立GPU纹理texel读回，也没有独立截取city绘制前atlas像素。生产before/after仅分配元数据，不冒充独立像素差。原crop清晰不等于所有场景远景文字可读。

已看23/24/20/21实际capture2：23东墙vent/staff贴纸可见；短盖沟很小；24 A牌和玻璃功能牌有实际文字；21横向店名与部分新增外墙空调可见；20部分外廊设备可见。不能据此称全部新增物件无遮挡、安装间隙全验收。七机位对C14/重复帧/性能数字由root独立离线分析，本文件不重复计算。

旧hidden-before/after/proof和facade/service CPU继续保留各自sourceHashes/dirty绑定，不能把历史中间状态全部标成最终HEAD。
