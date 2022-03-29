import {
  lonLatToTileNumbers, tileNumbersToLonLat,
  gcj02_To_gps84, gps84_To_gcj02,
  bd09_To_gps84, gps84_To_bd09
} from './support/coordConver.js'
import TransformClassBaidu from './support/transform-class-baidu'
import { setOptions, template } from './support/Util.js'
import WebMercatorViewport from 'viewport-mercator-project';
import { getDistanceScales, zoomToScale } from './support/web-mercator.js';
import fs from './shaders/fs.glsl';
import vs from './shaders/vs.glsl';
import * as mat4 from 'gl-matrix/mat4';
import * as vec4 from 'gl-matrix/vec4';

console.log('--lbp 14', 'customTileLayer.js', '', vs);

export default class customTileLayer {
  constructor(layerId, url, options) {
    this.id = layerId;
    this.type = "custom";
    this.renderingMode = '2d';
    this.url = url;

    this.options = {

      //服务器编号
      subdomains: null,

      minZoom: 3,
      maxZoom: 18,
      // TODO 两种方式区别
      tileType: 'xyz'   //bd09,xyz
    }
    setOptions(this, options)   //合并属性

    //着色器程序
    this.program;

    //存放当前显示的瓦片
    this.showTiles = []

    //存放所有加载过的瓦片
    this.tileCache = {}

    //存放瓦片号对应的经纬度
    this.gridCache = {}

    //记录渲染时的变换矩阵。
    //如果瓦片因为网速慢，在渲染完成后才加载过来，可以使用这个矩阵主动更新渲染
    this.matrix;

    this.map;

    //记录当前图层是否在显示
    this.isLayerShow;

    this.transformBaidu = new TransformClassBaidu()
  }

  onAdd(map, gl) {
    this.map = map;

    //初始化顶点着色器
    var vertexShader = gl.createShader(gl.VERTEX_SHADER);

    gl.shaderSource(vertexShader, vs);
    gl.compileShader(vertexShader);
    // Check the result of compilation
    var compiled = gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS);
    if (!compiled) {
      var error = gl.getShaderInfoLog(vertexShader);
      console.log('Failed to compile shader: ' + error);
      return null;
    }

    //初始化片元着色器
    var fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);

    gl.shaderSource(fragmentShader, fs);
    gl.compileShader(fragmentShader);
    //初始化着色器程序
    this.program = gl.createProgram();
    gl.attachShader(this.program, vertexShader);
    gl.attachShader(this.program, fragmentShader);
    gl.linkProgram(this.program);

    //获取顶点位置变量
    this.a_Pos = gl.getAttribLocation(this.program, "a_pos");
    this.a_TextCoord = gl.getAttribLocation(this.program, 'a_TextCoord');


    this.isLayerShow = true;
    map.on('move', () => {
      if (this.isLayerShow) {
        this.update(gl, map)
      }
    })
    map.on('moveend', () => {
      console.log('--lbp 169', 'customTileLayer.js', 'moveend', map.getZoom());
    })
    this.update(gl, map)
  }

  //渲染
  render(gl, matrix) {

    if (this.map.getZoom() < this.options.minZoom || this.map.getZoom() > this.options.maxZoom) return

    //记录变换矩阵，用于瓦片加载后主动绘制
    this.matrix = matrix;

    //应用着色程序
    //必须写到这里，不能写到onAdd中，不然gl中的着色程序可能不是上面写的，会导致下面的变量获取不到
    gl.useProgram(this.program);

    for (var tile of this.showTiles) {
      if (!tile.isLoad) continue;

      // region 纹理映射
      // 创建纹理对象
      var texture = gl.createTexture();
      // 绑定纹理对象
      gl.bindTexture(gl.TEXTURE_2D, texture);
      // 对纹理进行Y轴反转
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
      // 配置纹理参数
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
      // 配置纹理图像
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tile.img);
      // 获取纹理的存储位置
      var u_Sampler = gl.getUniformLocation(this.program, 'u_Sampler');
      // 将0号纹理传递给着色器
      gl.uniform1i(u_Sampler, 0);
      // endregion

      gl.bindBuffer(gl.ARRAY_BUFFER, tile.buffer);
      // 设置从缓冲区获取顶点数据的规则
      gl.vertexAttribPointer(this.a_Pos, tile.PosParam.size, gl.FLOAT, false, tile.PosParam.stride, tile.PosParam.offset);
      gl.vertexAttribPointer(this.a_TextCoord, tile.TextCoordParam.size, gl.FLOAT, false, tile.TextCoordParam.stride, tile.TextCoordParam.offset);
      // 激活顶点数据缓冲区
      gl.enableVertexAttribArray(this.a_Pos);
      gl.enableVertexAttribArray(this.a_TextCoord);

      // 设置位置的顶点参数
      this.setVertex(gl)

      // 开启阿尔法混合，实现注记半透明效果
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      // 绘制图形
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  //当map移除当前图层时调用
  onRemove(map, gl) {
    this.isLayerShow = false;
  }

  update(gl, map) {
    var center = map.getCenter();
    var zoom;
    var bounds = map.getBounds();

    var minTile, maxTile;
    if (this.options.tileType === 'xyz') {
      zoom = parseInt(map.getZoom() + 1.4);   //解决瓦片上文字偏大的问题
      //把当前显示范围做偏移，后面加载瓦片时会再偏移回来
      //如果不这样做的话，大比例尺时，瓦片偏移后，屏幕边缘会有空白区域
      var northWest = gps84_To_gcj02(bounds.getNorthWest())
      var southEast = gps84_To_gcj02(bounds.getSouthEast())
      //算出当前范围的瓦片编号
      minTile = lonLatToTileNumbers(northWest.lng, northWest.lat, zoom)
      maxTile = lonLatToTileNumbers(southEast.lng, southEast.lat, zoom)
    } else if (this.options.tileType === 'bd09') {
      zoom = parseInt(map.getZoom() + 1.8); //解决瓦片上文字偏大的问题
      var southWest = gps84_To_bd09(bounds.getSouthWest())
      var northEast = gps84_To_bd09(bounds.getNorthEast())
      minTile = this.transformBaidu.lnglatToTile(southWest.lng, southWest.lat, zoom)
      maxTile = this.transformBaidu.lnglatToTile(northEast.lng, northEast.lat, zoom)
    }
    var currentTiles = [];
    for (var x = minTile[0]; x <= maxTile[0]; x++) {
      for (var y = minTile[1]; y <= maxTile[1]; y++) {
        var xyz = {
          x: x,
          y: y,
          z: zoom
        }
        currentTiles.push(xyz)

        // 把瓦片号对应的经纬度缓存起来，
        // 存起来是因为贴纹理时需要瓦片4个角的经纬度，这样可以避免重复计算
        // 因为是保存的左上角经纬度，行和列向外多计算一个瓦片数，这样保证瓦片4个角都有经纬度可以取到
        this.addGridCache(xyz, 0, 0)
        if (x === maxTile[0]) this.addGridCache(xyz, 1, 0)
        if (y === maxTile[1]) this.addGridCache(xyz, 0, 1)
        if (x === maxTile[0] && y === maxTile[1]) this.addGridCache(xyz, 1, 1)
      }
    }

    // region 瓦片设置为从中间向周边的排序
    if (this.options.tileType === 'xyz') {
      var centerTile = lonLatToTileNumbers(center.lng, center.lat, zoom)  //计算中心点所在的瓦片号
    } else if (this.options.tileType === 'bd09') {
      centerTile = this.transformBaidu.lnglatToTile(center.lng, center.lat, zoom)
    }
    currentTiles.sort((a, b) => {
      return this.tileDistance(a, centerTile) - this.tileDistance(b, centerTile);
    });
    // endregion

    //加载瓦片
    this.showTiles = [];
    for (var xyz of currentTiles) {
      var titleKey = this.createTileKey(xyz)
      // 走缓存或新加载
      if (this.tileCache[titleKey]) {
        this.showTiles.push(this.tileCache[titleKey])
      } else {
        var tile = this.createTile(gl, xyz)
        this.showTiles.push(tile);
        this.tileCache[titleKey] = tile;
      }
    }
  }

  // 缓存瓦片号对应的经纬度
  addGridCache(xyz, xPlus, yPlus) {
    var key = this.createTileKey(xyz.x + xPlus, xyz.y + yPlus, xyz.z)
    if (!this.gridCache[key]) {
      if (this.options.tileType === 'xyz') {
        this.gridCache[key] = gcj02_To_gps84(tileNumbersToLonLat(xyz.x + xPlus, xyz.y + yPlus, xyz.z))
      } else if (this.options.tileType === 'bd09') {
        this.gridCache[key] = bd09_To_gps84(this.transformBaidu.pixelToLnglat(0, 0, xyz.x + xPlus, xyz.y + yPlus, xyz.z))
      }
    }
  }

  // 计算两个瓦片编号的距离
  tileDistance(tile1, tile2) {
    // 计算直角三角形斜边长度，c（斜边）=√（a²+b²）。（a，b为两直角边）
    // 欧式距离需要开根号，这里是否开根号对排序没有影响，为了性能优化，选择不开根号
    return Math.pow((tile1.x - tile2[0]), 2) + Math.pow((tile1.y - tile2[1]), 2)
  }

  // 创建瓦片id
  createTileKey(xyz, y, z) {
    if (xyz instanceof Object) {
      return xyz.z + '/' + xyz.x + '/' + xyz.y;
    } else {
      var x = xyz;
      return z + '/' + x + '/' + y;
    }
  }

  //创建瓦片
  createTile(gl, xyz) {
    //替换请求地址中的变量
    var _url = template(this.url, {
      s: this.options.subdomains[Math.abs(xyz.x + xyz.y) % this.options.subdomains.length],
      x: xyz.x,
      y: xyz.y,
      z: xyz.z
    });

    var tile = {
      xyz: xyz
    };

    // 瓦片编号转经纬度，并进行偏移
    var leftTop, rightTop, leftBottom, rightBottom;
    if (this.options.tileType === 'xyz') {
      leftTop = this.gridCache[this.createTileKey(xyz)]
      rightTop = this.gridCache[this.createTileKey(xyz.x + 1, xyz.y, xyz.z)]
      leftBottom = this.gridCache[this.createTileKey(xyz.x, xyz.y + 1, xyz.z)]
      rightBottom = this.gridCache[this.createTileKey(xyz.x + 1, xyz.y + 1, xyz.z)]
    } else if (this.options.tileType === 'bd09') {
      leftTop = this.gridCache[this.createTileKey(xyz.x, xyz.y + 1, xyz.z)]
      rightTop = this.gridCache[this.createTileKey(xyz.x + 1, xyz.y + 1, xyz.z)]
      leftBottom = this.gridCache[this.createTileKey(xyz)]
      rightBottom = this.gridCache[this.createTileKey(xyz.x + 1, xyz.y, xyz.z)]
    }

    // 顶点坐标+纹理坐标
    var attrData = new Float32Array([
      leftTop.lng, leftTop.lat, 0.0, 1.0,
      leftBottom.lng, leftBottom.lat, 0.0, 0.0,
      rightTop.lng, rightTop.lat, 1.0, 1.0,
      rightBottom.lng, rightBottom.lat, 1.0, 0.0
    ])

    var FSIZE = attrData.BYTES_PER_ELEMENT;
    // 创建缓冲区并传入数据
    var buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, attrData, gl.STATIC_DRAW);
    tile.buffer = buffer;
    // 从缓冲区中获取顶点数据的参数
    tile.PosParam = {
      size: 2,
      stride: FSIZE * 4,
      offset: 0
    }
    // 从缓冲区中获取纹理数据的参数
    tile.TextCoordParam = {
      size: 2,
      stride: FSIZE * 4,
      offset: FSIZE * 2
    }

    //加载瓦片
    var img = new Image();
    img.onload = () => {
      tile.img = img;
      tile.isLoad = true;

      this.map.triggerRepaint()  //主动让地图重绘
    };
    img.crossOrigin = true;
    img.src = _url;

    return tile;
  }

  // 设置位置的顶点参数 TODO 很重要吃透
  // 参考：https://github.com/xiaoiver/custom-mapbox-layer/blob/master/src/layers/PointCloudLayer2.ts
  setVertex(gl) {
    const currentZoomLevel = this.map.getZoom();
    const bearing = this.map.getBearing();
    const pitch = this.map.getPitch();
    const center = this.map.getCenter();
    const devicePixelRatio = window.devicePixelRatio;
    const viewport = new WebMercatorViewport({
      width: gl.drawingBufferWidth / devicePixelRatio,
      height: gl.drawingBufferHeight / devicePixelRatio,

      longitude: center.lng,
      latitude: center.lat,
      zoom: currentZoomLevel,
      pitch,
      bearing,
    });

    const { viewProjectionMatrix, projectionMatrix, viewMatrix, viewMatrixUncentered } = viewport;

    let drawParams = {
      // @ts-ignore
      'u_matrix': viewProjectionMatrix,
      'u_point_size': this.pointSize,
      'u_is_offset': false,
      'u_pixels_per_degree': [ 0, 0, 0 ],
      'u_pixels_per_degree2': [ 0, 0, 0 ],
      'u_viewport_center': [ 0, 0 ],
      'u_pixels_per_meter': [ 0, 0, 0 ],
      'u_project_scale': zoomToScale(currentZoomLevel),
      'u_viewport_center_projection': [ 0, 0, 0, 0 ],
    };

    if (currentZoomLevel > 12) {
      const { pixelsPerDegree, pixelsPerDegree2 } = getDistanceScales({
        longitude: center.lng,
        latitude: center.lat,
        zoom: currentZoomLevel,
        highPrecision: true
      });

      const positionPixels = viewport.projectFlat(
        [ Math.fround(center.lng), Math.fround(center.lat) ],
        Math.pow(2, currentZoomLevel)
      );

      const projectionCenter = vec4.transformMat4(
        [],
        [positionPixels[0], positionPixels[1], 0.0, 1.0],
        viewProjectionMatrix
      );

      // Always apply uncentered projection matrix if available (shader adds center)
      let viewMatrix2 = viewMatrixUncentered || viewMatrix;

      // Zero out 4th coordinate ("after" model matrix) - avoids further translations
      // viewMatrix = new Matrix4(viewMatrixUncentered || viewMatrix)
      //   .multiplyRight(VECTOR_TO_POINT_MATRIX);
      let viewProjectionMatrix2 = mat4.multiply([], projectionMatrix, viewMatrix2);
      const VECTOR_TO_POINT_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0];
      viewProjectionMatrix2 = mat4.multiply([], viewProjectionMatrix2, VECTOR_TO_POINT_MATRIX);

      drawParams['u_matrix'] = viewProjectionMatrix2;
      drawParams['u_is_offset'] = true;
      drawParams['u_viewport_center'] = [Math.fround(center.lng), Math.fround(center.lat)];
      drawParams['u_viewport_center_projection'] = projectionCenter;
      drawParams['u_pixels_per_degree'] = pixelsPerDegree && pixelsPerDegree.map(p => Math.fround(p));
      drawParams['u_pixels_per_degree2'] = pixelsPerDegree2 && pixelsPerDegree2.map(p => Math.fround(p));
    }


    gl.uniformMatrix4fv(gl.getUniformLocation(this.program, "u_matrix"), false, drawParams['u_matrix']);

    gl.uniform1f(gl.getUniformLocation(this.program, "u_project_scale"), drawParams['u_project_scale']);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_is_offset"), drawParams['u_is_offset'] ? 1 : 0);
    gl.uniform3fv(gl.getUniformLocation(this.program, "u_pixels_per_degree"), drawParams['u_pixels_per_degree']);
    gl.uniform3fv(gl.getUniformLocation(this.program, "u_pixels_per_degree2"), drawParams['u_pixels_per_degree2']);
    gl.uniform3fv(gl.getUniformLocation(this.program, "u_pixels_per_meter"), drawParams['u_pixels_per_meter']);
    gl.uniform2fv(gl.getUniformLocation(this.program, "u_viewport_center"), drawParams['u_viewport_center']);
    gl.uniform4fv(gl.getUniformLocation(this.program, "u_viewport_center_projection"), drawParams['u_viewport_center_projection']);

  }
}
