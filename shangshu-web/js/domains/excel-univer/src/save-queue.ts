/** 串行保存用户原操作。失败/未知时暂停，不替换编号或跳过未核实操作。 */
export class ManagedSaveQueue {
  private items: Array<{key:string;run:()=>Promise<boolean>}> = [];
  private running = false;
  private paused = false;
  private dead = false;
  get pending(): number { return this.items.length; }
  add(key:string,run:()=>Promise<boolean>):void {
    if (this.dead || this.items.some(item=>item.key===key)) return;
    this.items.push({key,run});
    void this.drain();
  }
  retry():void { if(this.dead)return;this.paused=false;void this.drain(); }
  dispose():void { this.dead=true;this.items=[]; }
  private async drain():Promise<void> {
    if(this.running||this.paused||this.dead)return;
    this.running=true;
    try {
      while(this.items.length&&!this.dead&&!this.paused){
        let success=false;
        try { success=await this.items[0].run(); } catch { /* 原操作负责展示错误并保留输入。 */ }
        if(this.dead)return;
        if(!success){this.paused=true;return;}
        this.items.shift();
      }
    } finally {this.running=false;}
  }
}
