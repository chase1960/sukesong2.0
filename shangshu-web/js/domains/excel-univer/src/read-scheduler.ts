/** 只调度视口读取：拖动期间替换等待页，已经发出的请求最多一个。 */
export class ViewportReadScheduler {
  private pending: number[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private generation = 0;
  constructor(private load: (page:number)=>Promise<unknown>, private failed:(error:unknown)=>void, private delay=120) {}
  schedule(pages:number[]) {
    this.pending=[...new Set(pages)];
    clearTimeout(this.timer);
    this.timer=setTimeout(()=>{this.timer=undefined;void this.drain();},this.delay);
  }
  reset() { this.generation++; this.pending=[];clearTimeout(this.timer);this.timer=undefined; }
  private async drain() {
    if(this.running||this.timer!==undefined)return;
    this.running=true;
    try {
      while(this.pending.length&&this.timer===undefined) {
        const page=this.pending.shift()!, generation=this.generation;
        try { await this.load(page); } catch(error) {if(generation===this.generation)this.failed(error);}
      }
    } finally { this.running=false; }
  }
}
