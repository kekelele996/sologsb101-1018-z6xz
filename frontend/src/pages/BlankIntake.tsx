/**
 * /blanks 制胎间：坯胎入库单与含水率复测
 * - 坯胎开出即开入库单；晾置中逐次复测含水率
 * - 排道次前只认最近一次复测：未达标压着等，达标放回可编排
 * - 编号或复测结论对不上的挂起，在本页人工判定
 * - 复测达标入库单可「转入髹涂台」建档；两阶段写入，一头失败只重试那一头
 * 消费 Blank、MoistureRetest、Body、Coat；复用 <StatBadge>、<FilterBar>、<EmptyPanel>。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  AuditOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SwapOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery, type FilterSelectConfig } from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import { useBlankStore, selectBlanksByStatus } from '@/stores/blankStore';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import {
  BLANK_MATERIAL_LABEL,
  BLANK_MATERIAL_OPTIONS,
  BLANK_SHAPE_LABEL,
  BLANK_SHAPE_OPTIONS,
  BLANK_STATUS_COLOR,
  BLANK_STATUS_LABEL,
  createEmptyBlankDraft,
  type Blank,
  type BlankDraft,
  type BlankStatus,
} from '@/types/blank';
import {
  RETEST_RESULT_OPTIONS,
  type MoistureRetest,
  type MoistureRetestDraft,
} from '@/types/retest';
import { RETEST_RESULT_COLOR, RETEST_RESULT_LABEL } from '@/types/blank';
import { judgeMoisture, moistureLimitHint, MOISTURE_LIMIT_PCT } from '@/utils/moisture';

const FILTER_KEYS = ['material', 'status'] as const;

const FILTER_SELECTS: ReadonlyArray<FilterSelectConfig> = [
  { key: 'material', label: '材质', options: BLANK_MATERIAL_OPTIONS },
  {
    key: 'status',
    label: '对账状态',
    options: (['inStock', 'ready', 'onFloor', 'held'] as BlankStatus[]).map((value) => ({
      value,
      label: BLANK_STATUS_LABEL[value],
    })),
  },
];

export default function BlankIntake() {
  const { message } = AntdApp.useApp();
  const [blankForm] = Form.useForm<BlankDraft>();
  const [retestForm] = Form.useForm<MoistureRetestDraft>();

  const blanks = useBlankStore((state) => state.blanks);
  const retests = useBlankStore((state) => state.retests);
  const createBlank = useBlankStore((state) => state.createBlank);
  const updateBlank = useBlankStore((state) => state.updateBlank);
  const removeBlank = useBlankStore((state) => state.removeBlank);
  const addRetest = useBlankStore((state) => state.addRetest);
  const removeRetest = useBlankStore((state) => state.removeRetest);
  const admitToFloor = useBlankStore((state) => state.admitToFloor);
  const resolveRetestHold = useBlankStore((state) => state.resolveRetestHold);
  const resolveCodeHold = useBlankStore((state) => state.resolveCodeHold);
  const backfillBlankForBody = useBlankStore((state) => state.backfillBlankForBody);
  const reconcile = useBlankStore((state) => state.reconcile);
  const loadBodies = useBodyStore((state) => state.loadBodies);

  const bodies = useBodyStore((state) => state.bodies);
  const coats = useCoatStore((state) => state.coats);

  const url = useFilterQuery(FILTER_KEYS);
  const [blankOpen, setBlankOpen] = useState(false);
  const [editingBlank, setEditingBlank] = useState<Blank | null>(null);
  const [retestTarget, setRetestTarget] = useState<Blank | null>(null);
  const [retestModalOpen, setRetestModalOpen] = useState(false);
  const [historyTarget, setHistoryTarget] = useState<Blank | null>(null);
  const [draftMoisture, setDraftMoisture] = useState(14);

  const bodyCodeById = useMemo(() => new Map(bodies.map((body) => [body.id, body.code])), [bodies]);

  // 髹涂台那头查无入库单的胎体（编号对不上，可在本页补开入库单）
  const orphanBodies = useMemo(
    () => bodies.filter((body) => !blanks.some((blank) => blank.code === body.code)),
    [bodies, blanks],
  );

  const filtered = useMemo(() => {
    const keyword = url.keyword.trim();
    const materials = url.values.material as Blank['material'][];
    const statuses = url.values.status as BlankStatus[];
    return selectBlanksByStatus(blanks, statuses).filter((blank) => {
      if (keyword.length > 0) {
        const haystack = `${blank.code}${blank.maker}${blank.holdReason}`;
        if (!haystack.includes(keyword)) return false;
      }
      if (materials.length > 0 && !materials.includes(blank.material)) return false;
      return true;
    });
  }, [blanks, url.keyword, url.values]);

  const stats = useMemo(() => {
    const waiting = blanks.filter((blank) => blank.status === 'inStock').length;
    const ready = blanks.filter((blank) => blank.status === 'ready').length;
    const onFloor = blanks.filter((blank) => blank.status === 'onFloor').length;
    const held = blanks.filter((blank) => blank.status === 'held').length;
    return { total: blanks.length, waiting, ready, onFloor, held };
  }, [blanks]);

  const openBlankCreate = (): void => {
    setEditingBlank(null);
    blankForm.setFieldsValue(createEmptyBlankDraft());
    setBlankOpen(true);
  };

  const openBlankEdit = (blank: Blank): void => {
    setEditingBlank(blank);
    blankForm.setFieldsValue({
      code: blank.code,
      material: blank.material,
      shape: blank.shape,
      sizeMm: blank.sizeMm,
      maker: blank.maker,
      madeDate: blank.madeDate,
      initialMoisturePct: blank.initialMoisturePct,
    });
    setBlankOpen(true);
  };

  const submitBlank = async (): Promise<void> => {
    const values = await blankForm.validateFields();
    if (editingBlank) {
      await updateBlank(editingBlank.id, values);
      message.success(`已更新入库单 ${values.code}`);
    } else {
      const created = await createBlank(values);
      message.success(`坯胎 ${created.code} 已入库晾置，复测达标后才能上漆`);
    }
    setBlankOpen(false);
  };

  const openRetest = (blank: Blank): void => {
    setRetestTarget(blank);
    const next = blank.lastMoisturePct ?? Math.max(blank.initialMoisturePct - 1, MOISTURE_LIMIT_PCT);
    setDraftMoisture(Number(next.toFixed(1)));
    retestForm.setFieldsValue({
      blankId: blank.id,
      date: new Date().toISOString().slice(0, 10),
      moisturePct: Number(next.toFixed(1)),
      result: judgeMoisture(next),
      tester: '',
      note: '',
    });
    setRetestModalOpen(true);
  };

  const submitRetest = async (): Promise<void> => {
    const values = await retestForm.validateFields();
    const outcome = await addRetest(values);
    // 两头各自成败：哪头失败只提示重试哪头，另一头照旧
    if (outcome.retest.ok && outcome.blank.ok) {
      message.success(values.result === 'pass' ? '复测合格，坯胎已放回可编排' : '复测未达标，坯胎压着继续晾');
    } else if (outcome.retest.ok && !outcome.blank.ok) {
      message.warning(`复测已记录；入库单回写失败：${outcome.blank.error}（复测那头不受影响，可稍后点「重新对账」重试）`);
    } else {
      message.error(`复测记录写入失败：${outcome.retest.error}，请重试这一条`);
    }
    setRetestModalOpen(false);
    setRetestTarget(null);
  };

  const handleAdmit = async (blank: Blank): Promise<void> => {
    const result = await admitToFloor(blank.id);
    if (result.body.ok && result.blank.ok) {
      message.success(`坯胎 ${blank.code} 已转入髹涂台，可编排头道漆`);
      await loadBodies();
    } else if (result.body.ok && !result.blank.ok) {
      // 第一头已成、第二头失败：胎体在髹涂台照旧保留，只重试回写
      message.warning(`髹涂台已按 ${blank.code} 建档；入库单回写失败：${result.blank.error}，可再点一次「转入」重试，不会重复建档`);
      await loadBodies();
    } else {
      message.error(`转入失败：${result.body.error}，制胎间这头未动，请重试`);
    }
  };

  const handleResolveRetest = async (blank: Blank): Promise<void> => {
    const outcome = await resolveRetestHold(blank.id);
    if (outcome.ok) message.success('已按仪器读数重新判定，挂起解除');
    else message.error(outcome.error);
  };

  const handleResolveCode = async (blank: Blank, targetBodyId: string): Promise<void> => {
    const outcome = await resolveCodeHold(blank.id, targetBodyId);
    if (outcome.ok) {
      message.success('道次已改挂到正确胎体，编号对账完成');
      await loadBodies();
    } else message.error(outcome.error);
  };

  const handleBackfill = async (bodyId: string): Promise<void> => {
    const outcome = await backfillBlankForBody(bodyId);
    if (outcome.ok) message.success('已补开坯胎入库单并追认放行');
    else message.error(outcome.error);
  };

  const handleReconcile = async (): Promise<void> => {
    const report = await reconcile();
    if (report.errors.length > 0) {
      message.warning(`对账完成，${report.changed} 张入库单更新；${report.errors.length} 条本头写回失败：${report.errors.join('；')}`);
    } else {
      message.success(`对账完成，${report.changed} 张入库单状态已更新`);
    }
  };

  const retestColumns: ColumnsType<MoistureRetest> = [
    { title: '复测日期', dataIndex: 'date', width: 110 },
    {
      title: '含水率',
      dataIndex: 'moisturePct',
      width: 100,
      render: (value: number) => (
        <Tag color={value <= MOISTURE_LIMIT_PCT ? '#2f6f4f' : '#b03a2e'}>{value}%</Tag>
      ),
    },
    {
      title: '结论',
      dataIndex: 'result',
      width: 90,
      render: (value: MoistureRetest['result']) => (
        <Tag color={RETEST_RESULT_COLOR[value]}>{RETEST_RESULT_LABEL[value]}</Tag>
      ),
    },
    { title: '复测人', dataIndex: 'tester', width: 100, render: (value: string) => value || '未填写' },
    { title: '备注', dataIndex: 'note', render: (value: string) => value || '—' },
    {
      title: '操作',
      key: 'action',
      width: 80,
      render: (_value, record) => (
        <Popconfirm
          title="删除该条复测"
          description="删除后入库单按剩余复测中最近一条重新判定。"
          okText="确认"
          cancelText="取消"
          onConfirm={() => void removeRetest(record.id).then(() => message.success('已删除该条复测'))}
        >
          <Button size="small" type="link" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ];

  const previewVerdict = judgeMoisture(draftMoisture);

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>制胎间 · 坯胎入库与含水率复测</h2>
          <p>
            开出坯胎先开入库单，按坯胎编号与髹涂工序台对账；{moistureLimitHint()}
            ，复测未达标压着等，编号或结论对不上先挂起等人判。
          </p>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void handleReconcile()}>
            重新对账
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openBlankCreate}>
            坯胎入库
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="在库坯胎" value={stats.total} suffix="具" tone="primary" />
        <StatBadge label="压着晾置" value={stats.waiting} suffix="具" tone="warning" />
        <StatBadge label="复测达标" value={stats.ready} suffix="具" tone="success" />
        <StatBadge label="已上漆" value={stats.onFloor} suffix="具" tone="info" />
        <StatBadge label="挂起待判" value={stats.held} suffix="具" tone="danger" />
      </div>

      {orphanBodies.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`髹涂台有 ${orphanBodies.length} 具胎体在制胎间查无入库单（编号对不上）：${orphanBodies
            .map((body) => body.code)
            .join('、')}`}
          description="这些胎体的头道漆已被闸门压下。若确属本间开出的坯胎，可补开入库单并追认放行。"
          action={
            <Space direction="vertical" size={4}>
              {orphanBodies.slice(0, 3).map((body) => (
                <Button
                  key={body.id}
                  size="small"
                  onClick={() => void handleBackfill(body.id)}
                >
                  补开 {body.code}
                </Button>
              ))}
            </Space>
          }
        />
      ) : null}

      <FilterBar
        keyword={url.keyword}
        onKeywordChange={url.setKeyword}
        selects={FILTER_SELECTS}
        values={url.values}
        onValuesChange={url.setValues}
        onReset={url.reset}
        keywordPlaceholder="搜索坯胎编号 / 制胎人 / 挂起原因…"
        actions={
          <Typography.Text type="secondary">
            共 {filtered.length} / {blanks.length} 具
          </Typography.Text>
        }
      />

      <div style={{ marginTop: 16 }}>
        {filtered.length === 0 ? (
          <EmptyPanel
            title={blanks.length === 0 ? '还没有坯胎入库' : '当前筛选条件下没有坯胎'}
            description={
              blanks.length === 0
                ? '制胎间开出坯胎后先登记入库单；晾置期间复测含水率，达标后方可转入髹涂台。'
                : '试着放宽材质或对账状态条件。'
            }
            actionText="坯胎入库"
            onAction={openBlankCreate}
            secondaryText="重置筛选"
            onSecondary={url.reset}
          />
        ) : (
          <Row gutter={[16, 16]}>
            {filtered.map((blank) => {
              const matchedBody = bodies.find((body) => body.id === blank.matchedBodyId) ?? null;
              const strayCoats = coats.filter(
                (coat) => coat.bodyCode === blank.code && bodyCodeById.get(coat.bodyId) !== blank.code,
              );
              const retestCount = retests.filter((row) => row.blankId === blank.id).length;
              return (
                <Col key={blank.id} xs={24} xl={12}>
                  <Card
                    className="gb-body-card"
                    title={
                      <Space size={6} wrap>
                        <Tag color="#8c2f1f">{blank.code}</Tag>
                        <Tag color={BLANK_STATUS_COLOR[blank.status]}>{BLANK_STATUS_LABEL[blank.status]}</Tag>
                      </Space>
                    }
                    extra={
                      <Space size={2}>
                        <Tooltip title="查看历次复测">
                          <Button size="small" type="link" onClick={() => setHistoryTarget(blank)}>
                            复测 {retestCount} 次
                          </Button>
                        </Tooltip>
                        <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openBlankEdit(blank)} />
                        <Popconfirm
                          title="删除入库单"
                          description="将同时删除其全部复测记录。已上漆的对账关系不会回退道次。"
                          okText="确认删除"
                          cancelText="取消"
                          onConfirm={() =>
                            void removeBlank(blank.id).then(() => message.success(`已删除入库单 ${blank.code}`))
                          }
                        >
                          <Button size="small" type="link" danger icon={<DeleteOutlined />} />
                        </Popconfirm>
                      </Space>
                    }
                  >
                    <Space direction="vertical" size={6} style={{ width: '100%' }}>
                      <Space size={6} wrap>
                        <Tag>{BLANK_MATERIAL_LABEL[blank.material]}</Tag>
                        <Tag>{BLANK_SHAPE_LABEL[blank.shape]}</Tag>
                        <Tag color="gold">{blank.sizeMm} mm</Tag>
                        <Tag>制胎：{blank.maker || '未填写'}</Tag>
                      </Space>
                      <Typography.Text type="secondary">
                        入库初测 {blank.initialMoisturePct}% · 开坯 {blank.madeDate}
                      </Typography.Text>
                      <Typography.Text>
                        最近复测：
                        {blank.lastRetestDate ? (
                          <>
                            {blank.lastRetestDate} ·{' '}
                            <Tag color={blank.lastMoisturePct !== null && blank.lastMoisturePct <= MOISTURE_LIMIT_PCT ? '#2f6f4f' : '#b03a2e'}>
                              {blank.lastMoisturePct ?? '—'}%
                            </Tag>
                            <Tag color={blank.lastRetestResult ? RETEST_RESULT_COLOR[blank.lastRetestResult] : '#8c8c8c'}>
                              {blank.lastRetestResult ? RETEST_RESULT_LABEL[blank.lastRetestResult] : '未复测'}
                            </Tag>
                          </>
                        ) : (
                          <Tag>尚未复测</Tag>
                        )}
                      </Typography.Text>
                      {matchedBody ? (
                        <Typography.Text type="secondary">
                          对账胎体：<Tag color="#8c2f1f">{matchedBody.code}</Tag>
                        </Typography.Text>
                      ) : null}

                      {blank.status === 'held' ? (
                        <Alert
                          type="error"
                          showIcon
                          style={{ marginTop: 4 }}
                          message={blank.holdReason || '编号或复测结论对不上，挂起等人判'}
                          action={
                            <Space direction="vertical" size={4}>
                              {blank.holdReason.includes('复测结论') ? (
                                <Button
                                  size="small"
                                  danger
                                  icon={<AuditOutlined />}
                                  onClick={() => void handleResolveRetest(blank)}
                                >
                                  按读数判定
                                </Button>
                              ) : null}
                              {blank.holdReason.includes('编号') ? (
                                <Select
                                  size="small"
                                  style={{ width: 190 }}
                                  placeholder="道次改挂到…"
                                  options={bodies.map((body) => ({
                                    value: body.id,
                                    label: `${body.code} · ${BLANK_SHAPE_LABEL[body.shape]}`,
                                  }))}
                                  onChange={(value: string) => void handleResolveCode(blank, value)}
                                />
                              ) : null}
                            </Space>
                          }
                        />
                      ) : null}

                      {strayCoats.length > 0 && blank.status !== 'held' ? (
                        <Alert
                          type="warning"
                          showIcon
                          style={{ marginTop: 4 }}
                          message={`发现 ${strayCoats.length} 条道次编号记为 ${blank.code}，可点「重新对账」核对归属`}
                        />
                      ) : null}

                      <Space size={6} wrap style={{ marginTop: 4 }}>
                        <Button size="small" type="primary" ghost icon={<ThunderboltOutlined />} onClick={() => openRetest(blank)}>
                          登记复测
                        </Button>
                        {blank.status === 'ready' ? (
                          <Button
                            size="small"
                            type="primary"
                            icon={<SwapOutlined />}
                            onClick={() => void handleAdmit(blank)}
                          >
                            转入髹涂台
                          </Button>
                        ) : null}
                        {blank.status === 'inStock' ? (
                          <Tooltip title="复测未达标，压着继续晾；达标复测后自动放回可编排">
                            <Button size="small" disabled>
                              晾置等待中
                            </Button>
                          </Tooltip>
                        ) : null}
                        {blank.status === 'onFloor' ? (
                          <Tag color="#3a6ea5" style={{ margin: 0 }}>
                            已上漆，不退回
                          </Tag>
                        ) : null}
                      </Space>
                    </Space>
                  </Card>
                </Col>
              );
            })}
          </Row>
        )}
      </div>

      {/* 坯胎入库 / 编辑 */}
      <Modal
        open={blankOpen}
        title={editingBlank ? `编辑入库单 ${editingBlank.code}` : '坯胎入库'}
        onCancel={() => setBlankOpen(false)}
        onOk={() => void submitBlank()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={blankForm} layout="vertical" preserve={false}>
          <Form.Item name="code" label="坯胎编号" rules={[{ required: true, message: '请输入编号，两头按它对账，如 LQ-2410' }]}>
            <Input placeholder="LQ-2410" disabled={editingBlank?.status === 'onFloor'} />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="material" label="材质" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...BLANK_MATERIAL_OPTIONS]} />
            </Form.Item>
            <Form.Item name="shape" label="器型" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...BLANK_SHAPE_OPTIONS]} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="sizeMm" label="主要尺寸（mm）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={10} max={2000} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="madeDate" label="开坯日期" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item
              name="initialMoisturePct"
              label="入库初测含水率（%）"
              rules={[{ required: true }]}
              style={{ flex: 1 }}
            >
              <InputNumber min={0} max={60} step={0.1} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="maker" label="制胎班组 / 师傅" style={{ flex: 1 }}>
              <Input placeholder="如：赵师傅" />
            </Form.Item>
          </Space>
          <Alert type="info" showIcon message={`${moistureLimitHint()}；金属胎可填 0 直接登记放行。`} />
        </Form>
      </Modal>

      {/* 复测登记 */}
      <Modal
        open={retestModalOpen}
        title={retestTarget ? `含水率复测 · ${retestTarget.code}` : '含水率复测'}
        onCancel={() => {
          setRetestModalOpen(false);
          setRetestTarget(null);
        }}
        onOk={() => void submitRetest()}
        okText="提交复测"
        cancelText="取消"
        destroyOnClose
      >
        <Form
          form={retestForm}
          layout="vertical"
          preserve={false}
          onValuesChange={(changed) => {
            if (typeof changed.moisturePct === 'number') {
              setDraftMoisture(changed.moisturePct);
              retestForm.setFieldValue('result', judgeMoisture(changed.moisturePct));
            }
          }}
        >
          <Form.Item name="blankId" hidden>
            <Input />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="date" label="复测日期" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
            <Form.Item
              name="moisturePct"
              label={`含水率（%，达标 ≤ ${MOISTURE_LIMIT_PCT}）`}
              rules={[{ required: true }]}
              style={{ flex: 1 }}
            >
              <InputNumber min={0} max={60} step={0.1} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="result" label="复测结论" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...RETEST_RESULT_OPTIONS]} />
            </Form.Item>
            <Form.Item name="tester" label="复测人" style={{ flex: 1 }}>
              <Input placeholder="如：赵师傅" />
            </Form.Item>
          </Space>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="仪器读数、晾置情况等" />
          </Form.Item>
          <Alert
            type={previewVerdict === 'pass' ? 'success' : 'warning'}
            showIcon
            message={
              previewVerdict === 'pass'
                ? `按读数 ${draftMoisture}% 应判合格：坯胎将放回可编排`
                : `按读数 ${draftMoisture}% 应判不合格：坯胎压着继续晾`
            }
            description="结论可人工改；若与读数矛盾，入库单会自动挂起等人判。"
          />
        </Form>
      </Modal>

      {/* 复测历史 */}
      <Modal
        open={historyTarget !== null}
        title={historyTarget ? `复测历史 · ${historyTarget.code}` : '复测历史'}
        onCancel={() => setHistoryTarget(null)}
        footer={null}
        width={720}
        destroyOnClose
      >
        {historyTarget ? (
          retests.filter((row) => row.blankId === historyTarget.id).length === 0 ? (
            <EmptyPanel title="该坯胎还没有复测记录" description="第一次复测前不能编排头道漆。" size="small" />
          ) : (
            <>
              <Timeline
                items={retests
                  .filter((row) => row.blankId === historyTarget.id)
                  .slice(0, 6)
                  .map((row) => ({
                    color: row.result === 'pass' ? 'green' : 'red',
                    children: (
                      <Space direction="vertical" size={0}>
                        <Typography.Text strong>
                          {row.date} · {row.moisturePct}% · {RETEST_RESULT_LABEL[row.result]}
                        </Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {row.tester || '未填写'}
                          {row.note ? `　${row.note}` : ''}
                        </Typography.Text>
                      </Space>
                    ),
                  }))}
              />
              <Table<MoistureRetest>
                rowKey="id"
                size="small"
                pagination={false}
                columns={retestColumns}
                dataSource={retests.filter((row) => row.blankId === historyTarget.id)}
              />
            </>
          )
        ) : null}
      </Modal>
    </div>
  );
}
