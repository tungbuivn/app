import * as fs from "fs";
import * as path from "path";
import { Inject, ReflectiveInjector } from "injection-js";
import { DelaunayPlane } from "../autolevel/dx.js";
import { Files } from "../Files.js";
import { GCode } from "./index.js";
import { splitSegment } from "../autolevel/splitSeg.js";
import { resolveHeight } from "../autolevel/resolveHeight.js";
function fmt(v) {
  return v.toFixed(4);
}
export class RefactorHeightMap {
  static get parameters() {
    return [new Inject(Files), new Inject(GCode), new Inject(DelaunayPlane)];
  }

  /**
   *
   * @param {Files} files
   * @param {GCode} gcode
   * @param {DelaunayPlane} delaunayPlane
   */
  constructor(files, gcode, delaunayPlane) {
    /**
     * @type {Files}
     */
    this._files = files;
    /**
     * @type {GCode}
     */
    this._gcode = gcode;
    /**
     * @type {DelaunayPlane}
     */
    this._delaunayPlane = delaunayPlane;
  }
  generateTriangleGcode(triangles) {
    var str = [].concat(triangles).map((o) => {
      o.push(o[0]);
      var l = null;
      var rs = o
        .map((a) => {
          return `G1 X${a.x} Y${a.y} Z${a.z}`;
        })
        .join("\n");
      return `G00 Z5\nG00 X${o[0].x}Y${o[0].y}\n${rs}`;
    });
    fs.writeFileSync("./tri.nc", str.join("\n"));
  }
  run(gcodeFile, heightmapFile) {
    var code = this._gcode.loadFile(gcodeFile);

    var counter = 0;
    var seglist = code.data.reduce((a, o, i) => {
      if (o.ord.match(/G0\s/) || o.ord.match(/G00/)) {
        counter++;
      }
      a[counter] = a[counter] || { idx: [], data: [] };
      //   a[counter].idx.push(i);
      if (o.ord.match(/G01/)) {
        o.idx = i;
        a[counter].data.push(o);
      }
      return a;
    }, []);
    var tri = this._delaunayPlane.loadPointsFromFile(heightmapFile);
    
    this.generateTriangleGcode([].concat(tri.triangles));
    var lines = [].concat(
      ...tri.triangles.map((o) => {
        o.push(o[0]);
        var last = null;
        return o.reduce((x, y, i) => {
          if (last == null) {
          } else {
            x.push([last, y]);
          }
          last = y;
          return x;
        }, []);
      })
    );
    var mpe = seglist
      .filter((o) => o.data.length > 0)
      .reduce((a, b, i) => {
        var last = null;
        var spl = b.data.reduce((x, y) => {
          if (last == null) {
            last = y;
            return x;
          }
          var spl = splitSegment(last, y, ...lines);
          x.push({ from: last, to: y, spl });
          last = y;
          return x;
        }, []);
        a.push(spl);
        return a;
      }, []);
    // join segments
    var lastIdx = undefined;
    var merged = mpe.map((a) => {
      var data = [].concat(
        ...a.map((x, i) => {
          var d = x.spl;
          if (i > 0) {
            d.shift();
          }
          return d;
        })
      );
      return data;
    });
    var joinData = merged
      .reduce((a, b, i) => {
        var from = b[0].idx;
        var to = b[b.length - 1].idx;
        for (var j = from; j <= to; j++) {
          a[j] = null;
        }
        a[from] = b;
        //   var seg1 = a.slice(0, from);
        //   var seg2 = a.slice(to + 1);
        return a;
      }, [].concat(code.data))
      .map((o) => {
        if (o && o.length) {
          return [].concat(...o);
        }
        return [o];
      });
    joinData = []
      .concat(...joinData)
      .filter((o) => o != null)
      .map((o) => {
        if (o.ord) {
          if (typeof o.resolvedZ == "undefined" && !isNaN(o.x) && !isNaN(o.y)) {
            for (var tr of tri.triangles) {
              var it = resolveHeight(o, tr[0], tr[1], tr[2]);
              if (it != null) {
                o.resolvedZ = it.z;
                break;
              }
            }
          }
          return o;
        }
        o.ord = `G01 X${fmt(o.x)} Y${fmt(o.y)} Z${fmt(o.z)}`;

        return o;
      });
    // map height
    joinData = joinData.map((o) => {
      o.ord = o.ord.replace(/([XYZ])/gi, " $1");
      o.update = o.ord.replace(/\s+/g," ");
      if (isNaN(o.z)) {
        return o;
      }
      if (o.z == 5) return o;
      if (!o.ord.match(/^\(/g) && o.ord.match(/Z/i) && !isNaN(o.resolvedZ)) {
        o.update = o.ord
          .replace(/z/gi, " Z")
          .split(" ")
          .reduce((a, b) => {
            if (b.match(/z/gi)) {
              b = b.replace(/z/gi, "");
              b = `Z${fmt(o.z + o.resolvedZ)}`;
            }
            a.push(b);
            return a;
          }, [])
          .filter((q) => q != "")
          .join(" ");
      } else {
        var po = [o.ord];
        if (!isNaN(o.z) && !isNaN(o.resolvedZ)) {
          po.push(`Z${fmt(o.z + o.resolvedZ)}`);
        }
        o.update = po.join(" ").replace(/\s+/g," ");;
      }
      o.update=`${o.update}${o.comment||""}`;
      return o;
    });
    var dir = path.dirname(gcodeFile).replace(/\\/gi, "/");
    var file = path.basename(gcodeFile);
    var outFile = `${dir}/almod-${file}`;
    joinData.unshift({update:`(This GCode script was designed to adjust the Z height of a CNC machine according)
(to the minute variations in the surface height in order to achieve a better result in the milling/etching process)
(This script is the output of AutoLevellerAE, 0.9.5u2 Changeset: ...2d0387 @ http://autoleveller.co.uk)
(Author: James Hawthorne PhD. File creation date: 26-06-2021 10:06)
(This program and any of its output is licensed under GPLv2 and as such...)
(AutoLevellerAE comes with ABSOLUTELY NO WARRANTY; for details, see sections 11 and 12 of the GPLv2 @ http://www.gnu.org/licenses/old-licenses/gpl-2.0.html)

G90 G21 S20000 G17

M0 (Attach probe wires and clips that need attaching)
(Initialize probe routine)
G1 X${tri.min.x} Y${tri.min.y} F1000 (Move to bottom left corner)
G31 Z-100 F50 (Probe to a maximum of the specified probe height at the specified feed rate)
G92 Z0 (Touch off Z to 0 once contact is made)
G0 Z5
M0 (Detach any clips used for probing)
    `})
    fs.writeFileSync(outFile, joinData.map((o) => o.update).join("\n"));
    console.log(`Creating output file ${outFile}`);
  }
}
